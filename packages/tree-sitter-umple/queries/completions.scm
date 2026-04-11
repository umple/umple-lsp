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

; Sorted key — offer attributes of owner class only
(sorted_modifier) @scope.sorted_attribute

; =====================
; TOP-LEVEL SCOPES
; =====================
(source_file) @scope.top_level
(mixset_definition) @scope.mixset_body
(statemachine_definition) @scope.state
(requirement_definition) @scope.none
; Suppress completions inside require body (opaque content)
(require_body) @scope.suppress
; filter blocks: no symbol completions by default…
(filter_definition) @scope.none
; …except inside include statements, where class names are valid targets
(filter_value) @scope.class

; =====================
; CLASS-LIKE SCOPES (offer type names)
; =====================
(class_definition) @scope.class_body
(trait_definition) @scope.trait_body
(interface_definition) @scope.interface_body
(association_class_definition) @scope.assoc_class_body
(isa_declaration) @scope.class_interface_trait

; =====================
; ASSOCIATION SCOPES (offer type names — classes, interfaces, traits)
; =====================
(association_definition) @scope.class_interface_trait
(association_inline) @scope.class_interface_trait
(association_member) @scope.class_interface_trait

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
; Guard expressions — sentinel for keyword filtering + scoped attr/method completion
(guard) @scope.guard_attribute_method

; trace entity references — sentinel for keyword filtering + scoped attr/method completion
; All trace entity forms use the same completion scope
(trace_statement (trace_entity) @scope.trace_attribute_method)
(trace_statement (trace_entity_call) @scope.trace_attribute_method)
(trace_postfix "record" . (identifier) @scope.trace_attribute_method)

; referenced_statemachine definition — offer statemachine names from enclosing class
(referenced_statemachine definition: (identifier) @scope.statemachine)

; depend java.util.* — suppress (not a symbol reference)
(depend_statement) @scope.suppress

; implementsReq R1, R2 — offer requirement names
(req_implementation) @scope.requirement

; [name != ""] — offer only own attributes (Umple E28: no inherited attrs in constraints)
(constraint) @scope.own_attribute

; =====================
; OTHER
; =====================
(enum_definition) @scope.none
(use_statement) @scope.use_path
(template_list) @scope.template
