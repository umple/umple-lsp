; completions.scm — Scope detection for symbol completions.
;
; Used by the LSP server to determine which symbols to offer.
; Capture names follow the pattern: @scope.<kind1>_<kind2>_...
; where each <kind> is a SymbolKind.
;
; The LSP finds the innermost (smallest) capture containing
; the cursor and offers symbols of the encoded kinds.
;
; @scope.none    = keywords only (no symbol completions)
; @scope.suppress = suppress ALL completions
; @scope.use_path = trigger file path completions

; =====================
; SUPPRESS CONTEXTS
; =====================
; Method/code bodies — not Umple completion context
(code_content) @scope.suppress
(code_block) @scope.suppress

; =====================
; TOP-LEVEL SCOPES (keywords only)
; =====================
(source_file) @scope.none
(mixset_definition) @scope.none
(statemachine_definition) @scope.none
(requirement_definition) @scope.none

; =====================
; CLASS-LIKE SCOPES (offer type names)
; =====================
(class_definition) @scope.class_interface_trait_enum
(trait_definition) @scope.class_interface_trait_enum
(interface_definition) @scope.class_interface_trait_enum
(association_class_definition) @scope.class_interface_trait_enum
(isa_declaration) @scope.class_interface_trait_enum

; =====================
; ASSOCIATION SCOPES (offer class names only)
; =====================
(association_definition) @scope.class
(association_inline) @scope.class
(association_member) @scope.class

; =====================
; STATE MACHINE SCOPES (offer state names)
; =====================
(state_machine) @scope.state
(state) @scope.state
(transition) @scope.state

; =====================
; FINE-GRAINED CLASS MEMBER SCOPES
; =====================
; key { attr1, attr2 } — offer attribute names (scoped to class + inherited)
(key_definition) @scope.attribute

; depend java.util.* — suppress (not a symbol reference)
(depend_statement) @scope.suppress

; [name != ""] — offer only own attributes (Umple E28: no inherited attrs in constraints)
(constraint) @scope.own_attribute

; =====================
; OTHER
; =====================
(enum_definition) @scope.none
(use_statement) @scope.use_path
(template_list) @scope.template
