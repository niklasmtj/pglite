import { states, slot, waitFor, FsError } from "./shared.js";
import type {
  FsStats,
  ResponseJson,
  ResponseJsonOk,
  ResponseJsonError,
  OpenFd,
  FileSystemSyncAccessHandle,
  CallMsg,
} from "./shared.js";

// State
let fdCounter = 10;
const openFd = new Map<number, OpenFd>();

let controlBuffer: SharedArrayBuffer;
let callBuffer: SharedArrayBuffer;
let responseBuffer: SharedArrayBuffer;
let sharedBuffers: SharedArrayBuffer[];

let controlArray: Int32Array;
let callArray: Uint8Array;
let responseArray: Uint8Array;

let root: FileSystemDirectoryHandle;

async function init() {
  // Root OPFS
  root = await navigator.storage.getDirectory();

  // send 'here' message to indicate that the worker is ready
  self.postMessage({ type: "here" });

  // Wait for the main thread to send the buffers
  const msg = await new Promise<{
    controlBuffer: SharedArrayBuffer;
    callBuffer: SharedArrayBuffer;
    responseBuffer: SharedArrayBuffer;
    sharedBuffers: SharedArrayBuffer[];
  }>((resolve) => {
    self.addEventListener(
      "message",
      (event) => {
        if (event.data.type === "init") {
          resolve(event.data);
        } else {
          throw new Error("Unexpected message from main thread");
        }
      },
      { once: true },
    );
  });

  controlBuffer = msg.controlBuffer;
  callBuffer = msg.callBuffer;
  responseBuffer = msg.responseBuffer;
  sharedBuffers = msg.sharedBuffers;

  controlArray = new Int32Array(controlBuffer);
  callArray = new Uint8Array(callBuffer);
  responseArray = new Uint8Array(responseBuffer);

  // Send the 'ready' message to the main thread
  self.postMessage({ type: "ready" });
  mainLoop();
}

async function mainLoop() {
  while (true) {
    waitForState(states.CALL);
    setState(states.PROCESS);
    const callLength = Atomics.load(controlArray, slot.CALL_LENGTH);
    const callMsg: CallMsg = JSON.parse(
      new TextDecoder().decode(callArray.slice(0, callLength)),
    );
    let responseJson: ResponseJson;
    try {
      if (!methods[callMsg.method]) {
        throw new Error(`Method not found: ${callMsg.method}`);
      }
      const result = await methods[callMsg.method](...callMsg.args);
      responseJson = { value: result } as ResponseJsonOk;
    } catch (error) {
      responseJson = {
        error: {
          message: (error as FsError).message,
          code: (error as FsError).code,
        },
      } as ResponseJsonError;
    }
    const responseJsonStr = JSON.stringify(responseJson);
    const responseJsonStrBytes = new TextEncoder().encode(responseJsonStr);
    responseArray.set(responseJsonStrBytes);
    Atomics.store(
      controlArray,
      slot.RESPONSE_LENGTH,
      responseJsonStrBytes.length,
    );
    setState(states.RESPONSE);
  }
}

const methods: Record<string, (...args: any[]) => any> = {
  async close(fd: number): Promise<void> {
    const fdEntry = openFd.get(fd);
    if (!fdEntry) {
      throw new Error(`File descriptor not found: ${fd}`);
    }
    fdEntry.syncHandle.close();
    openFd.delete(fd);
  },

  async fstat(fd: number): Promise<FsStats> {
    const fdEntry = openFd.get(fd);
    if (!fdEntry) {
      throw new Error(`File descriptor not found: ${fd}`);
    }
    return await statForHandle(fdEntry.handle, fdEntry.syncHandle);
  },

  async lstat(path: string): Promise<FsStats> {
    const handle = await resolveHandle(path);
    return await statForHandle(handle);
  },

  async mkdir(
    path: string,
    options?: { recursive: boolean; mode: number },
  ): Promise<void> {
    const parts = path.split("/");
    const tip = parts.pop()!;
    let currentDir = root;
    try {
      for (const part of parts) {
        currentDir = await currentDir.getDirectoryHandle(part, {
          create: options?.recursive,
        });
      }
    } catch (error) {
      throw new FsError("ENOENT", `Dir not found: ${path}`);
    }
    currentDir.getDirectoryHandle(tip, { create: true });
  },

  async open(path: string, _flags?: string, _mode?: number): Promise<number> {
    const handle = await resolveFileHandle(path);
    const id = fdCounter++;
    openFd.set(id, {
      id,
      path,
      handle,
      syncHandle: await (handle as any).createSyncAccessHandle(),
    });
    return id;
  },

  async readdir(path: string): Promise<string[]> {
    const dirHandle = await resolveDirectoryHandle(path);
    const entries = [];
    for await (const entry of (dirHandle as any).keys()) {
      entries.push(entry);
    }
    return entries;
  },

  async read(
    fd: number,
    buffer: number, // number of sharedBuffer or -1 for copy via responseBuffer
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    const fdEntry = openFd.get(fd);
    if (!fdEntry) {
      throw new Error(`File descriptor not found: ${fd}`);
    }
    if (buffer >= 0) {
      const sharedBuffer = sharedBuffers[buffer];
      if (!sharedBuffer) {
        throw new Error(`Shared buffer not found: ${buffer}`);
      }
      const view = new Uint8Array(sharedBuffer, offset, length);
      const bytesRead = fdEntry.syncHandle.read(view, { at: position });
      return bytesRead;
    } else {
      // TODO
      return 0;
    }
  },

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (await resolveHandle(newPath)) {
      throw new Error(`File already exists: ${newPath}`);
    }
    const handle = await resolveHandle(oldPath);
    const type = handle.kind;
    const newPathParts = newPath.split("/");
    const newEntryName = newPathParts.pop()!;
    const newDirHandle = await resolveDirectoryHandle(
      newPathParts.slice(0, -1),
    );
    if (type === "file") {
      const oldFile = await handle.getFile();
      const newFileHandle = await newDirHandle.getFileHandle(newEntryName, {
        create: true,
      });
      const newFile = await newFileHandle.createWritable();
      await newFile.write(oldFile);
      await (handle as any).remove();
    } else {
      throw new Error("Rename directory not implemented");
    }
  },

  async rmdir(path: string): Promise<void> {
    const handle = await resolveDirectoryHandle(path);
    await (handle as any).remove();
  },

  async truncate(path: string, len: number): Promise<void> {
    const handle = await resolveFileHandle(path);
    const syncHandle: FileSystemSyncAccessHandle = await (
      handle as any
    ).createSyncAccessHandle();
    syncHandle.truncate(len);
  },

  async unlink(path: string): Promise<void> {
    const handle = await resolveFileHandle(path);
    await (handle as any).remove();
  },

  async writeFile(
    path: string,
    data: string,
    _options?: { encoding: string; mode: number; flag: string },
  ): Promise<void> {
    const handle = await resolveFileHandle(path, true);
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  },

  async write(
    fd: number,
    buffer: number, // number of sharedBuffer or -1 for copy via responseBuffer
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    const fdEntry = openFd.get(fd);
    if (!fdEntry) {
      throw new Error(`File descriptor not found: ${fd}`);
    }
    if (buffer >= 0) {
      const sharedBuffer = sharedBuffers[buffer];
      if (!sharedBuffer) {
        throw new Error(`Shared buffer not found: ${buffer}`);
      }
      const view = new Uint8Array(sharedBuffer, offset, length);
      const bytesWritten = fdEntry.syncHandle.write(view, { at: position });
      return bytesWritten;
    } else {
      // TODO
      return 0;
    }
  },
};

async function resolveDirectoryHandle(
  path: string | string[],
  create = false,
): Promise<FileSystemDirectoryHandle> {
  try {
    const pathParts = Array.isArray(path) ? path : path.split("/");
    let handle = root;
    for (const part of pathParts) {
      if (!part) {
        continue;
      }
      handle = await handle.getDirectoryHandle(part, { create });
    }
    return handle;
  } catch (error) {
    throw new FsError("ENOENT", `Dir not found: ${path}`);
  }
}

async function resolveFileHandle(
  path: string,
  create = false,
  createDirs = false,
): Promise<FileSystemFileHandle> {
  try {
    const pathParts = path.split("/");
    const fileName = pathParts.pop()!;
    const dirHandle = await resolveDirectoryHandle(pathParts, createDirs);
    return dirHandle.getFileHandle(fileName, { create });
  } catch (error) {
    throw new FsError("ENOENT", `File not found: ${path}`);
  }
}

async function resolveHandle(
  path: string,
): Promise<FileSystemFileHandle | FileSystemDirectoryHandle> {
  const pathParts = Array.isArray(path) ? path : path.split("/");
  const tip = pathParts.pop()!;
  let handle = root;
  try {
    for (const part of pathParts) {
      if (!part) {
        continue;
      }
      handle = await handle.getDirectoryHandle(part);
    }
  } catch {
    throw new FsError("ENOENT", `Path not found: ${path}`);
  }
  try {
    return await handle.getFileHandle(tip);
  } catch {
    try {
      return await handle.getDirectoryHandle(tip);
    } catch {
      throw new FsError("ENOENT", `Path not found: ${path}`);
    }
  }
}

async function statForHandle(
  handle: FileSystemHandle,
  syncHandle?: FileSystemSyncAccessHandle,
): Promise<FsStats> {
  const kind = handle.kind;
  if (!syncHandle && kind === "file") {
    syncHandle = await (handle as any).createSyncAccessHandle();
  }
  const size = syncHandle?.getSize() ?? 0;
  const blksize = 4096;
  const blocks = Math.ceil(size / blksize);
  return {
    dev: 0,
    ino: 0,
    mode: kind === "file" ? 32768 : 16384,
    nlink: 0,
    uid: 0,
    gid: 0,
    rdev: 0,
    size,
    atime: 0,
    mtime: 0,
    ctime: 0,
    blksize,
    blocks,
  };
}

function waitForState(state: number) {
  waitFor(controlArray, slot.STATE, state);
}

function setState(state: number) {
  controlArray[slot.STATE] = state;
  Atomics.notify(controlArray, slot.STATE);
}

init();
