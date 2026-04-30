import { jsonToJs, jsToJson } from './converter';

export function scratchToUCF(blocksArray: any[], options: any = {}) {
  return jsonToJs(blocksArray, options);
}

export function ucfToScratch(ucfString: string, options: any = {}) {
  return jsToJson(ucfString, options);
}
