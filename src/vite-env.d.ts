/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEV_HOME?: string;
  readonly VITE_DEV_LOCAL_ROOT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
