import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  FileVideo,
  Folder,
  HardDrive,
  type LucideIcon,
} from "lucide-react";
import { fileKind, type FileKind } from "../../lib/files";
import { cn } from "../ui/cn";

/* The shape says what kind of file it is; colour says only one thing, folder or not. Folders are the places
   you can go, so they take the accent with a light fill; every file stays muted. */
const ICONS: Record<FileKind, LucideIcon> = {
  folder: Folder,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  document: FileText,
  code: FileCode2,
  data: FileJson2,
  disk: HardDrive,
  file: File,
};

export function FileIcon({ name, isDir, className }: { name: string; isDir: boolean; className?: string }) {
  const kind = fileKind(name, isDir);
  const Icon = ICONS[kind];
  return <Icon className={cn("size-4 shrink-0", kind === "folder" ? "fill-primary-ink/15 text-primary-ink" : "text-muted-foreground", className)} aria-hidden />;
}
