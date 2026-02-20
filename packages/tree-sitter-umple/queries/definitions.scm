; definitions.scm — Maps AST nodes to symbol definitions for indexing.
;
; Used by the LSP server to build the symbol index.
; Capture names follow the pattern: @definition.<kind>
; where <kind> is a SymbolKind ("class", "attribute", "state", etc.)
;
; The LSP walks up from each captured node to find the enclosing
; parent scope (class, statemachine, etc.) for scoped lookups.

; =====================
; TOP-LEVEL DEFINITIONS
; =====================

(class_definition name: (identifier) @definition.class)
(interface_definition name: (identifier) @definition.interface)
(trait_definition name: (identifier) @definition.trait)
(enum_definition name: (identifier) @definition.enum)
(external_definition name: (identifier) @definition.class)
(association_definition name: (identifier) @definition.association)
(requirement_definition name: (identifier) @definition.requirement)
(mixset_definition name: (identifier) @definition.mixset)
(association_class_definition name: (identifier) @definition.class)
(statemachine_definition name: (identifier) @definition.statemachine)

; =====================
; SCOPED DEFINITIONS
; =====================
; These require a parent scope (class, statemachine, etc.)

(attribute_declaration name: (identifier) @definition.attribute)
(method_declaration name: (identifier) @definition.method)
(method_signature name: (identifier) @definition.method)
(state_machine name: (identifier) @definition.statemachine)
(state name: (identifier) @definition.state)
(referenced_statemachine name: (identifier) @definition.statemachine)
