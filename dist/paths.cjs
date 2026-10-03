"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/paths.ts
var paths_exports = {};
__export(paths_exports, {
  dataRoot: () => dataRoot,
  default: () => paths_default
});
module.exports = __toCommonJS(paths_exports);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var dataRoot = import_node_path.default.resolve(process.env.MODS_FOR_T3_DATA || (process.platform === "darwin" ? import_node_path.default.join(import_node_os.default.homedir(), "Library", "Application Support", "Mods for T3 Code") : process.platform === "win32" ? import_node_path.default.join(process.env.APPDATA || import_node_os.default.homedir(), "Mods for T3 Code") : import_node_path.default.join(process.env.XDG_DATA_HOME || import_node_path.default.join(import_node_os.default.homedir(), ".local", "share"), "mods-for-t3-code")));
var paths = { dataRoot };
var paths_default = paths;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  dataRoot
});
