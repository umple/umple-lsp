export const UMPLE_DIAGNOSTIC_SOURCE = "umple compiler";
export const LEGACY_UMPLE_DIAGNOSTIC_SOURCE = "umple";

export function isUmpleDiagnosticSource(source: unknown): boolean {
  return (
    source === UMPLE_DIAGNOSTIC_SOURCE ||
    source === LEGACY_UMPLE_DIAGNOSTIC_SOURCE
  );
}
