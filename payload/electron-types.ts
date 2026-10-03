/** The narrow Electron boundary used by the trusted patch runtime. */
export interface ElectronSession {
  registerPreloadScript(script: { type: "frame"; filePath: string; id?: string }): string;
}
export interface ElectronContents {
  id: number;
  session: ElectronSession;
  isDestroyed(): boolean;
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
  on(event: "did-finish-load", listener: () => void): void;
  once(event: "destroyed", listener: () => void): void;
}
export interface ElectronApp {
  on(event: "web-contents-created", listener: (event: unknown, contents: ElectronContents) => void): void;
  on(event: "browser-window-created", listener: (event: unknown, window: { webContents: ElectronContents }) => void): void;
  once(event: "will-quit", listener: () => void): void;
}
export interface ElectronApi {
  app: ElectronApp;
  contextBridge: { executeInMainWorld(script: {func: () => void}): unknown };
}
