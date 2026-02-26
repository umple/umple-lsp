; references.scm — Maps identifiers to the symbol kinds they can reference.
;
; Used by the LSP server for context-aware go-to-definition.
; Capture names follow the pattern: @reference.<kind1>_<kind2>_...
; where each <kind> is a SymbolKind ("class", "attribute", "state", etc.)
;
; When the cursor is on a captured node, the LSP looks up definitions
; matching any of the kinds in the capture name. Identifiers NOT matched
; by any pattern get null (no go-to-definition).

; =====================
; DEFINITION NAMES
; =====================
; Go-to-definition on a definition name finds other definitions of that kind
; (e.g., clicking a class name can jump to its other partial definition)

(class_definition name: (identifier) @reference.class)
(interface_definition name: (identifier) @reference.interface)
(trait_definition name: (identifier) @reference.trait)
(enum_definition name: (identifier) @reference.enum)
(mixset_definition name: (identifier) @reference.mixset)
(requirement_definition name: (identifier) @reference.requirement)
(association_class_definition name: (identifier) @reference.class)
(statemachine_definition name: (identifier) @reference.statemachine)
(state_machine name: (identifier) @reference.statemachine)
(referenced_statemachine name: (identifier) @reference.statemachine)
(referenced_statemachine definition: (identifier) @reference.statemachine)
(state name: (identifier) @reference.state)
(association_definition name: (identifier) @reference.association)
(attribute_declaration name: (identifier) @reference.attribute)
(method_declaration name: (identifier) @reference.method)

; =====================
; TYPE REFERENCES
; =====================
; Attribute types, method return types, parameters — can be any named type

(type_name (qualified_name (identifier) @reference.class_interface_trait_enum))

; =====================
; ISA (INHERITANCE)
; =====================

(isa_declaration
  (type_list
    (type_name
      (qualified_name (identifier) @reference.class_interface_trait))))

; =====================
; USE STATEMENTS
; =====================
; use without .ump extension references a mixset

(use_statement path: (_) @reference.mixset)

; =====================
; REQUIREMENT REFERENCES
; =====================

(req_implementation (identifier) @reference.requirement)

; =====================
; TOP-LEVEL CODE INJECTION
; =====================
; before/after/around { ClassName } — target must be a class

(toplevel_code_injection target: (identifier) @reference.class)

; =====================
; ASSOCIATION TYPE REFERENCES
; =====================
; Types in associations can only be classes

(association_inline right_type: (identifier) @reference.class)
(association_member left_type: (identifier) @reference.class)
(association_member right_type: (identifier) @reference.class)
(single_association_end type: (identifier) @reference.class)

; =====================
; STATE REFERENCES
; =====================

(transition target: (identifier) @reference.state)
(standalone_transition from_state: (identifier) @reference.state)
(standalone_transition to_state: (identifier) @reference.state)

; =====================
; KEY DEFINITION
; =====================
; Identifiers inside key { } reference attributes

(key_definition (identifier) @reference.attribute)

; =====================
; CONSTRAINT IDENTIFIERS
; =====================
; Identifiers inside constraints reference attributes

(constraint (identifier) @reference.attribute)

; =====================
; EMIT METHOD & TEMPLATE
; =====================
(emit_method name: (identifier) @reference.method)
(template_attribute name: (identifier) @reference.template)
(template_list template_name: (identifier) @reference.template)
