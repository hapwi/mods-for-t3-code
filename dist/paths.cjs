const path = require("node:path");
const os = require("node:os");
exports.dataRoot = path.resolve(process.env.MODS_FOR_T3_DATA || (
  process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "Mods for T3 Code") :
  process.platform === "win32" ? path.join(process.env.APPDATA || os.homedir(), "Mods for T3 Code") :
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "mods-for-t3-code")
));
