/** English text-recognition data, shipped as an npm package so nothing is downloaded at runtime. */
declare module "@tesseract.js-data/eng" {
  const data: { code: string; gzip: boolean; langPath: string };
  export = data;
}
