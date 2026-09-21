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

/* The reference colours only the types worth telling apart at a glance: folders indigo, archives
   amber, images and video pink, audio purple; documents and everything else stay muted. */
const ICONS: Record<FileKind, { icon: LucideIcon; className: string }> = {
  folder: { icon: Folder, className: "text-folder" },
  image: { icon: FileImage, className: "text-pink-400" },
  video: { icon: FileVideo, className: "text-pink-400" },
  audio: { icon: FileAudio, className: "text-purple-400" },
  archive: { icon: FileArchive, className: "text-amber-400" },
  document: { icon: FileText, className: "text-muted-foreground" },
  code: { icon: FileCode2, className: "text-muted-foreground" },
  data: { icon: FileJson2, className: "text-muted-foreground" },
  disk: { icon: HardDrive, className: "text-muted-foreground" },
  file: { icon: File, className: "text-muted-foreground" },
};

export function FileIcon({ name, isDir, className }: { name: string; isDir: boolean; className?: string }) {
  const { icon: Icon, className: tone } = ICONS[fileKind(name, isDir)];
  return <Icon className={cn("size-4 shrink-0", tone, className)} strokeWidth={1.75} aria-hidden />;
}
