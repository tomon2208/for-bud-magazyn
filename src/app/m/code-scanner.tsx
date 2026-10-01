"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_LOCATION_CODE_LENGTH, parseScannedCode } from "@/lib/validation/locations";

type CameraState =
  | { kind: "starting" }
  | { kind: "active" }
  | { kind: "denied" }
  | { kind: "unavailable"; reason: string };

const INVALID_CODE = "To nie jest kod lokalizacji. Zeskanuj etykietę na półce.";

/**
 * Skaner kodu lokalizacji (kamera + ręczny wpis) — wspólny dla ekranu SKANUJ i kroków operacji magazynowych.
 * `onCode` jest wywoływane RAZ z poprawnym, znormalizowanym kodem (kamera zatrzymana). Aby skanować ponownie
 * (np. nieznany kod), rodzic montuje komponent od nowa (`key`). `message` — komunikat rodzica (np. „Nieznany kod”).
 */
export function CodeScanner({
  onCode,
  message: externalMessage,
  submitLabel = "Szukaj",
}: {
  onCode: (code: string) => void;
  message?: string | null;
  submitLabel?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const handled = useRef(false); // zabezpieczenie przed wielokrotnym odczytem tego samego kodu
  const lastInvalid = useRef({ text: "", at: 0 });
  const onCodeRef = useRef(onCode);
  const [camera, setCamera] = useState<CameraState>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0); // zmiana uruchamia kamerę ponownie
  const [message, setMessage] = useState<string | null>(null);
  const [manual, setManual] = useState("");

  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  const accept = useCallback((code: string) => {
    if (handled.current) return;
    handled.current = true;
    try {
      navigator.vibrate?.(80);
    } catch {
      // wibracja jest dodatkiem (np. niedostępna na iOS)
    }
    onCodeRef.current(code);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let scanner: import("qr-scanner").default | null = null;
    handled.current = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera({
          kind: "unavailable",
          reason: window.isSecureContext
            ? "Ta przeglądarka nie udostępnia kamery."
            : "Kamera wymaga połączenia HTTPS.",
        });
        return;
      }
      try {
        // Biblioteka tylko w przeglądarce (dynamic import) — nie trafia do bundla Workera ani innych ekranów.
        const { default: QrScanner } = await import("qr-scanner");
        if (cancelled || !videoRef.current) return;
        if (!(await QrScanner.hasCamera())) {
          if (!cancelled) setCamera({ kind: "unavailable", reason: "Nie wykryto kamery w tym urządzeniu." });
          return;
        }
        scanner = new QrScanner(
          videoRef.current,
          (result) => {
            if (handled.current) return;
            const code = parseScannedCode(result.data);
            if (code) {
              scanner?.stop(); // zatrzymanie kamery od razu po odczycie
              accept(code);
              return;
            }
            // Obcy kod (np. URL): komunikat, skanujemy dalej; ten sam obcy kod nie odświeża stanu co klatkę.
            const now = Date.now();
            if (lastInvalid.current.text !== result.data || now - lastInvalid.current.at > 3000) {
              lastInvalid.current = { text: result.data, at: now };
              setMessage(INVALID_CODE);
            }
          },
          {
            returnDetailedScanResult: true,
            // Domyślnie biblioteka analizuje 2/3 kadru zmniejszone do 400 px — za mało dla etykiety 3×8
            // (moduł ≈ 1 mm). Obszar 80% kadru i 640 px daje ok. 2× więcej pikseli na moduł (ADR 008).
            calculateScanRegion: (video: HTMLVideoElement) => {
              const side = Math.round(Math.min(video.videoWidth, video.videoHeight) * 0.8);
              return {
                x: Math.round((video.videoWidth - side) / 2),
                y: Math.round((video.videoHeight - side) / 2),
                width: side,
                height: side,
                downScaledWidth: 640,
                downScaledHeight: 640,
              };
            },
            preferredCamera: "environment",
            maxScansPerSecond: 8,
            highlightScanRegion: true,
            highlightCodeOutline: true,
          },
        );
        await scanner.start();
        if (cancelled) {
          scanner.destroy();
          return;
        }
        setCamera({ kind: "active" });
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof DOMException ? error.name : "";
        const text = String(error);
        if (name === "NotAllowedError" || name === "SecurityError" || /permission|denied|allowed/i.test(text)) {
          setCamera({ kind: "denied" });
        } else if (name === "NotFoundError" || /camera not found|no camera/i.test(text)) {
          setCamera({ kind: "unavailable", reason: "Nie wykryto kamery w tym urządzeniu." });
        } else {
          setCamera({ kind: "unavailable", reason: "Nie udało się uruchomić kamery." });
        }
      }
    }
    void start();

    return () => {
      cancelled = true;
      scanner?.destroy(); // zwalnia kamerę przy wyjściu ze strony / zmianie kroku
    };
  }, [attempt, accept]);

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = parseScannedCode(manual);
    if (!code) {
      setMessage(
        manual.trim() === ""
          ? "Wpisz kod lokalizacji."
          : `Nieprawidłowy kod. Dozwolone: litery A–Z, cyfry, . _ - (maks. ${MAX_LOCATION_CODE_LENGTH} znaków, bez spacji).`,
      );
      return;
    }
    accept(code);
  }

  const shown = message ?? externalMessage ?? null;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black sm:aspect-video">
        <video ref={videoRef} playsInline muted className="size-full object-cover" />
        {camera.kind !== "active" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-white">
            {camera.kind === "starting" && <p className="text-lg">Uruchamianie kamery…</p>}
            {camera.kind === "denied" && (
              <>
                <p className="text-lg font-semibold">Brak zgody na użycie kamery</p>
                <p>Zezwól na kamerę dla tej strony w ustawieniach przeglądarki albo wpisz kod ręcznie poniżej.</p>
                <Button
                  type="button"
                  variant="secondary"
                  className="h-12 px-6 text-base"
                  onClick={() => (setCamera({ kind: "starting" }), setAttempt((n) => n + 1))}
                >
                  Spróbuj ponownie
                </Button>
              </>
            )}
            {camera.kind === "unavailable" && (
              <>
                <p className="text-lg font-semibold">Kamera niedostępna</p>
                <p>{camera.reason} Wpisz kod ręcznie poniżej.</p>
              </>
            )}
          </div>
        )}
      </div>

      <p className="text-center text-muted-foreground">Skieruj kamerę na kod QR na półce</p>

      {shown && (
        <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive">
          {shown}
        </p>
      )}

      <form onSubmit={submitManual} className="space-y-3 rounded-2xl border bg-background p-4" noValidate>
        <label htmlFor="manual-code" className="block text-lg font-semibold">
          Albo wpisz kod ręcznie
        </label>
        <Input
          id="manual-code"
          value={manual}
          onChange={(e) => (setManual(e.target.value), setMessage(null))}
          maxLength={MAX_LOCATION_CODE_LENGTH + 10}
          placeholder="np. A-03-02"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          className="h-16 rounded-xl px-4 font-mono text-2xl uppercase"
        />
        <Button type="submit" className="h-14 w-full rounded-xl text-xl font-bold">
          {submitLabel}
        </Button>
      </form>
    </div>
  );
}
