import { promises } from './fs-shim';
export const readFile = promises.readFile, writeFile = promises.writeFile, appendFile = promises.appendFile, mkdir = promises.mkdir,
  readdir = promises.readdir, stat = promises.stat, rm = promises.rm, unlink = promises.unlink, rename = promises.rename,
  copyFile = promises.copyFile, access = promises.access;
export default promises;
