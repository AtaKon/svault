declare const __SV_BUILD_VERSION__: string | null | undefined;

/** The release build injects its tag into the client; other builds use this fallback. */
export const APP_VERSION = (typeof __SV_BUILD_VERSION__ !== "undefined" && __SV_BUILD_VERSION__) || "1.2.0";
