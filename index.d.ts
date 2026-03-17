export type InstallRNNetInspectOptions = {
  inspectorUrl?: string;
  appName?: string;
  captureBodies?: boolean;
  patchFetch?: boolean;
  patchXHR?: boolean;
};

export declare function installRNNetInspect(
  options?: InstallRNNetInspectOptions
): () => void;

declare const _default: typeof installRNNetInspect;
export default _default;
