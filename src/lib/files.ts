// File-type classification for icons and labels.

export type FileKind = "folder" | "image" | "video" | "audio" | "archive" | "document" | "code" | "data" | "disk" | "file";

const KINDS: Record<Exclude<FileKind, "folder" | "file">, string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg", "raw", "cr2", "cr3", "nef", "arw", "dng", "psd", "ai"],
  video: ["mp4", "mov", "mkv", "avi", "m4v", "mxf", "webm", "wmv", "mpg", "mpeg", "prores", "r3d", "braw", "ts", "m2ts"],
  audio: ["mp3", "wav", "aac", "flac", "m4a", "ogg", "aif", "aiff", "wma", "opus"],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso"],
  document: ["pdf", "doc", "docx", "txt", "md", "rtf", "odt", "pages", "ppt", "pptx", "key", "xls", "xlsx", "numbers", "csv"],
  code: ["js", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "swift", "kt", "rb", "php", "sh", "html", "css", "scss"],
  data: ["json", "xml", "yaml", "yml", "toml", "ini", "conf", "cfg", "log", "sqlite", "db"],
  disk: ["img", "vmdk", "qcow2", "vdi"],
};

const byExt = new Map<string, FileKind>();
for (const [kind, exts] of Object.entries(KINDS)) for (const ext of exts) byExt.set(ext, kind as FileKind);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(name: string, isDir: boolean): FileKind {
  if (isDir) return "folder";
  return byExt.get(extensionOf(name)) ?? "file";
}
