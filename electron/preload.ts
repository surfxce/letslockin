import { contextBridge, ipcRenderer } from "electron";

/**
 * The only bridge across contextIsolation. `desktop` lets the page leave reminders to
 * the main process (which can notify with no window open) and make room for the
 * macOS window buttons; `pickFolder` is a native folder picker for importing;
 * `savePdf` prints the export page to a PDF file, which `openFile`/`showFile` then
 * open; `microphone` asks macOS to let a viva hear spoken answers. In a plain browser
 * tab this object is simply absent.
 */
contextBridge.exposeInMainWorld("lockin", {
  desktop: true,
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("lockin:pickFolder"),
  savePdf: (pathname: string, title: string) => ipcRenderer.invoke("lockin:savePdf", pathname, title),
  openFile: (file: string): Promise<string | null> => ipcRenderer.invoke("lockin:openFile", file),
  showFile: (file: string): Promise<string | null> => ipcRenderer.invoke("lockin:showFile", file),
  checkUpdate: () => ipcRenderer.invoke("lockin:checkUpdate"),
  installUpdate: (): Promise<string | null> => ipcRenderer.invoke("lockin:installUpdate"),
  microphone: (): Promise<"granted" | "denied" | "unavailable"> => ipcRenderer.invoke("lockin:microphone"),
});
