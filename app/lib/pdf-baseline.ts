import { useCallback, useEffect, useRef, useState } from "react";

export type PdfBaseline = {
  id: string;
  capturedAt: number;
  pdf?: Blob;
  error?: string;
  storageWarning?: string;
};

// One baseline per paper/provider/tab, replaced only when a new message is sent.
// IndexedDB keeps PDF bytes off the server and survives a page refresh.
async function baselineRecord(key: string, value?: PdfBaseline): Promise<PdfBaseline | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("lattice-pdf-baselines", 1);
    const timeout = window.setTimeout(() => reject(new Error("Local snapshot storage timed out")), 5000);
    const finish = () => window.clearTimeout(timeout);
    request.onupgradeneeded = () => request.result.createObjectStore("baselines");
    request.onerror = () => { finish(); reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("baselines", value ? "readwrite" : "readonly");
      const store = transaction.objectStore("baselines");
      const operation = value ? store.put(value, key) : store.get(key);
      transaction.oncomplete = () => { finish(); db.close(); resolve(value ?? operation.result ?? null); };
      transaction.onabort = transaction.onerror = () => { finish(); db.close(); reject(transaction.error); };
    };
  });
}

function tabKey(scope: string) {
  let tab = sessionStorage.getItem("lattice:pdf-comparison-tab");
  if (!tab) {
    tab = crypto.randomUUID();
    sessionStorage.setItem("lattice:pdf-comparison-tab", tab);
  }
  return `${tab}:${scope}`;
}

export function usePdfBaseline(scope: string) {
  const [record, setRecord] = useState<{ scope: string; value: PdfBaseline } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const version = ++generation.current;
    let cancelled = false;
    async function restore() {
      const key = tabKey(scope);
      const expected = sessionStorage.getItem(`lattice:pdf-baseline:${key}`);
      if (!expected) return;
      const value = await baselineRecord(key);
      if (cancelled || version !== generation.current) return;
      setRecord({ scope, value: value?.id === expected ? value : {
        id: expected, capturedAt: 0,
        error: "The snapshot for your last message is unavailable. A new one will be captured with your next message.",
      } });
    }
    restore().catch(() => {
      if (!cancelled && version === generation.current) setRecord({ scope, value: {
        id: "unavailable", capturedAt: 0, error: "Local PDF snapshots could not be restored in this browser.",
      } });
    });
    return () => { cancelled = true; };
  }, [scope]);

  const capture = useCallback(async (url: string | null) => {
    const version = ++generation.current;
    const value: PdfBaseline = { id: crypto.randomUUID(), capturedAt: Date.now() };
    try {
      if (!url) throw new Error("The paper could not compile before your last message. Highlights need a successful before-PDF; the agent can still help fix it.");
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Could not save the before-PDF for your last message.");
      const pdf = await response.blob();
      if (pdf.size > 64 * 1024 * 1024) throw new Error("This PDF exceeds the 64 MB comparison snapshot limit.");
      if (!(await pdf.slice(0, 5).text()).startsWith("%PDF-")) throw new Error("The before-PDF was not a valid PDF file.");
      value.pdf = pdf;
    } catch (error) {
      value.error = error instanceof Error ? error.message : "Could not capture the before-PDF.";
    }
    try {
      const key = tabKey(scope);
      // Invalidate the old snapshot even if saving the new one fails (e.g. quota).
      sessionStorage.setItem(`lattice:pdf-baseline:${key}`, value.id);
      await baselineRecord(key, value);
    } catch {
      value.storageWarning = "This snapshot is available only until refresh; local storage is unavailable.";
    }
    if (version === generation.current) setRecord({ scope, value });
    return value;
  }, [scope]);

  return { baseline: record?.scope === scope ? record.value : null, capture };
}
