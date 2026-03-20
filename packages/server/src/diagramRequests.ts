/**
 * Custom LSP request handlers for diagram click-to-select.
 * Registers umple/resolveStateLocation and umple/resolveTransitionLocation.
 */

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { Connection, Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SymbolIndex } from "./symbolIndex";
import { resolveStateLocation, resolveTransitionLocation } from "./diagramNavigation";

type DiagramDeps = {
  symbolIndex: SymbolIndex;
  isSymbolIndexReady: () => boolean;
  getDocument: (uri: string) => TextDocument | undefined;
  getDocumentFilePath: (doc: TextDocument) => string | null;
};

export function registerDiagramRequests(
  connection: Connection,
  deps: DiagramDeps,
): void {
  // Resolve a state location from a diagram click payload
  connection.onRequest(
    "umple/resolveStateLocation",
    async (params: {
      uri: string;
      className?: string;
      stateMachine: string;
      statePath: string[];
    }): Promise<{ uri: string; range: Range } | null> => {
      if (!deps.isSymbolIndexReady() || !params.statePath.length) return null;

      const filePath = deps.getDocumentFilePath({
        uri: params.uri,
      } as TextDocument);
      if (!filePath) return null;

      // Ensure the file is indexed
      const doc = deps.getDocument(params.uri);
      if (doc) {
        deps.symbolIndex.indexFile(filePath, doc.getText());
      }

      const symbol = resolveStateLocation(
        deps.symbolIndex,
        filePath,
        params.className,
        params.stateMachine,
        params.statePath,
      );

      if (!symbol) return null;

      return {
        uri: pathToFileURL(symbol.file).toString(),
        range: {
          start: { line: symbol.line, character: symbol.column },
          end: { line: symbol.endLine, character: symbol.endColumn },
        },
      };
    },
  );

  // Resolve a transition location from a diagram click payload
  connection.onRequest(
    "umple/resolveTransitionLocation",
    async (params: {
      uri: string;
      className?: string;
      stateMachine: string;
      event: string;
      sourcePath: string[];
      targetPath: string[];
      guard?: string;
    }): Promise<{ uri: string; range: Range } | null> => {
      if (!deps.isSymbolIndexReady() || !params.event) return null;

      const filePath = deps.getDocumentFilePath({
        uri: params.uri,
      } as TextDocument);
      if (!filePath) return null;

      const doc = deps.getDocument(params.uri);
      const content = doc
        ? doc.getText()
        : fs.existsSync(filePath)
          ? fs.readFileSync(filePath, "utf8")
          : null;
      if (!content) return null;

      const result = resolveTransitionLocation(
        deps.symbolIndex,
        filePath,
        content,
        params.className,
        params.stateMachine,
        params.sourcePath,
        params.event,
        params.targetPath,
        params.guard,
      );

      if (!result) return null;

      return {
        uri: pathToFileURL(filePath).toString(),
        range: {
          start: { line: result.line, character: result.column },
          end: { line: result.endLine, character: result.endColumn },
        },
      };
    },
  );
}
