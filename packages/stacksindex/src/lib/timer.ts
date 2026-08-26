// oxlint-disable id-length

export const formatEta = (ms: number) => {
  // If less than 1 second, return ms.
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = Math.floor(ms / 1000);

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds - h * 3600) / 60);
  const s = seconds - h * 3600 - m * 60;

  const hstr = h > 0 ? `${h}h ` : "";
  const mstr = m > 0 || h > 0 ? `${m < 10 && h > 0 ? "0" : ""}${m}m ` : "";
  const sstr = s > 0 || m > 0 ? `${s < 10 && m > 0 ? "0" : ""}${s}s` : "";

  return `${hstr}${mstr}${sstr}`;
};

export function startClock() {
  // oxlint-disable-next-line no-undef
  const start = performance.now();
  // oxlint-disable-next-line no-undef
  return () => performance.now() - start;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(() => {
      resolve();
    }, ms);
  });
