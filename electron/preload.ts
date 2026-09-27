import { contextBridge, ipcRenderer } from "electron";

/**
 * The only bridge across contextIsolation: a native folder picker, so importing
 * does not mean typing a path by hand. The page can still be used in a browser,
 * where this object is simply absent.
 */
contextBridge.exposeInMainWorld("lockin", {
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("lockin:pickFolder"),
});
