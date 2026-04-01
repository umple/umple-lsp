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
(requirement_definition name: (identifier) @reference.requirement)
(requirement_definition name: (req_id) @reference.requirement)

; =====================
; TRAIT PARAMETER REFERENCES
; =====================
; Constraint interfaces in <TP isA I1 & I2> — must be interfaces
(trait_parameter_constraint (qualified_name (identifier) @reference.interface))
; Default types in <TP = DefaultClass> — can be any named type
(trait_parameter default: (qualified_name (identifier) @reference.class_interface_trait))
; Binding values in isA T<TP = C1> — can be any named type
(trait_binding value: (qualified_name (identifier) @reference.class_interface_trait))
; Trait SM binding: isA T<sm1 as sm.s2>
; param references trait-side statemachine; value path references class-side SM/state
(trait_sm_binding param: (identifier) @reference.statemachine)
(trait_sm_binding value: (qualified_name (identifier) @reference.statemachine_state))
; NOTE: trait_sm_operation identifiers are NOT captured here — goto-def is handled
; entirely by tokenAnalysis.ts context detection. Adding a capture here would widen
; refs/rename scope, which is deferred for trait SM operations.
(enum_value name: (identifier) @reference.enum_value)
(external_definition name: (identifier) @reference.class)
(mixset_definition name: (identifier) @reference.mixset)
(association_class_definition name: (identifier) @reference.class)
(statemachine_definition name: (identifier) @reference.statemachine)
(state_machine name: (identifier) @reference.statemachine)
(referenced_statemachine definition: (identifier) @reference.statemachine)
(state name: (identifier) @reference.state)
(association_definition name: (identifier) @reference.association)
(attribute_declaration name: (identifier) @reference.attribute)
(const_declaration name: (identifier) @reference.const)
(method_declaration name: (identifier) @reference.method)
(method_signature name: (identifier) @reference.method)
(trait_method_signature name: (identifier) @reference.method)

; =====================
; TYPE REFERENCES
; =====================
; Attribute types, method return types, parameters — can be any named type

(type_name (qualified_name (identifier) @reference.class_interface_trait_enum))

; =====================
; ATTRIBUTE/CONST DEFAULT VALUE REFERENCES
; =====================
; Default values can reference attributes, consts, or enum values
; (qualified_name directly under attribute/const_declaration is the value position,
;  not the type (which is inside type_name) or the name (which is a field identifier))

; Non-final segment (qualifier): "Status" in "Status.ACTIVE" → enum reference
(attribute_declaration (qualified_name (identifier) @reference.enum . (identifier)))
(const_declaration (qualified_name (identifier) @reference.enum . (identifier)))

; Final or only segment: "ACTIVE" in "Status.ACTIVE", or "MAX" in "x = MAX" → value reference
(attribute_declaration (qualified_name (identifier) @reference.attribute_const_enum_value .))
(const_declaration (qualified_name (identifier) @reference.attribute_const_enum_value .))

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
; TOP-LEVEL CODE INJECTION
; =====================
; before/after/around { ClassName } — target must be a class
(toplevel_code_injection target: (identifier) @reference.class)
; before/after/around { ClassName } operation() — method reference
(toplevel_code_injection operation: (identifier) @reference.method)

; before/after method hook — method name reference
(before_after (identifier) @reference.method)

; =====================
; REQUIREMENT REFERENCES
; =====================
; implementsReq R01, R02; — requirement name references
(req_implementation (identifier) @reference.requirement)
(req_implementation (req_id) @reference.requirement)

; =====================
; ASSOCIATION TYPE REFERENCES
; =====================
; Types in associations — can be classes, interfaces, or traits

(association_inline right_type: (identifier) @reference.class_interface_trait)
(association_member left_type: (identifier) @reference.class_interface_trait)
(association_member right_type: (identifier) @reference.class_interface_trait)
(single_association_end type: (identifier) @reference.class_interface_trait)

; Sorted association key — attribute reference against the owning class
(sorted_modifier sort_key: (identifier) @reference.attribute)

; =====================
; STATE REFERENCES
; =====================

(transition target: (qualified_name (identifier) @reference.state))
(standalone_transition from_state: (identifier) @reference.state)
(standalone_transition to_state: (identifier) @reference.state)

; =====================
; KEY DEFINITION
; =====================
; Identifiers inside key { } reference attributes

(key_definition (identifier) @reference.attribute)

; =====================
; CONSTRAINT & GUARD IDENTIFIERS
; =====================
; Identifiers inside constraints/guards reference attributes or constants

(constraint (identifier) @reference.attribute_const_enum_value)
(guard (identifier) @reference.attribute_const_enum_value_method)

; =====================
; TRACE ENTITY REFERENCES
; =====================
; "trace count;" — identifier after "trace" keyword references attribute or method
; Uses anonymous node anchor to skip tracecase/activate/deactivate identifiers
(trace_statement "trace" . (identifier) @reference.attribute_method)
; "record x" in trace postfix — additional entity reference
(trace_postfix "record" . (identifier) @reference.attribute_method)
; tracecase definition name and activate/deactivate references
(trace_statement name: (identifier) @reference.tracecase)
(trace_statement "activate" . (identifier) @reference.tracecase)
(trace_statement "deactivate" . (identifier) @reference.tracecase)

; =====================
; EMIT METHOD & TEMPLATE
; =====================
(emit_method name: (identifier) @reference.method)
(template_attribute name: (identifier) @reference.template)
(template_list template_name: (identifier) @reference.template)

; =====================
; FILTER VALUE CLASS REFERENCES
; =====================
; include ClassName; — plain names (no wildcards) reference classes.
; Wildcard/exclusion patterns (Conn*, ~Foo, ?) are skipped via the
; match predicate: only tokens that look like plain identifiers qualify.
(filter_value
  (filter_pattern) @reference.class
  (#match? @reference.class "^[A-Za-z_][A-Za-z0-9_]*$"))
