import { SymbolKind } from "vscode-languageserver/node";
import type { SymbolKind as UmpleSymbolKind } from "./tokenTypes";

export function umpleKindToLspSymbolKind(kind: UmpleSymbolKind): SymbolKind {
  switch (kind) {
    case "class":
      return SymbolKind.Class;
    case "interface":
      return SymbolKind.Interface;
    case "trait":
      return SymbolKind.Interface;
    case "enum":
      return SymbolKind.Enum;
    case "enum_value":
      return SymbolKind.EnumMember;
    case "attribute":
      return SymbolKind.Field;
    case "port":
      return SymbolKind.Property;
    case "const":
      return SymbolKind.Constant;
    case "method":
      return SymbolKind.Method;
    case "template":
      return SymbolKind.Field;
    case "statemachine":
      return SymbolKind.Struct;
    case "state":
      return SymbolKind.EnumMember;
    case "association":
      return SymbolKind.Property;
    case "mixset":
      return SymbolKind.Module;
    case "requirement":
      return SymbolKind.String;
    case "use_case_step":
      return SymbolKind.Event;
    default:
      return SymbolKind.Variable;
  }
}
