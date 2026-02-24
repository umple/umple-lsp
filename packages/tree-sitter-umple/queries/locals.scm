; Tree-sitter locals queries for Umple
; Defines scopes and local definitions/references

; =============
; SCOPES
; =============

; Class creates a scope
(class_definition) @local.scope

; Interface creates a scope
(interface_definition) @local.scope

; Trait creates a scope
(trait_definition) @local.scope

; Methods create a scope
(method_declaration) @local.scope

; State machines create a scope
(state_machine) @local.scope

; States can create nested scopes
(state) @local.scope

; New constructs create scopes
(mixset_definition) @local.scope
(association_class_definition) @local.scope
(requirement_definition) @local.scope
(statemachine_definition) @local.scope
(emit_method) @local.scope

; =============
; DEFINITIONS
; =============

; Class name is a definition
(class_definition
  name: (identifier) @local.definition.type)

; Interface name is a definition
(interface_definition
  name: (identifier) @local.definition.type)

; Trait name is a definition
(trait_definition
  name: (identifier) @local.definition.type)

; Enum name is a definition
(enum_definition
  name: (identifier) @local.definition.type)

; Attribute names are definitions
(attribute_declaration
  name: (identifier) @local.definition.field)

; Const names are definitions
(const_declaration
  name: (identifier) @local.definition.constant)

; Method names are definitions
(method_declaration
  name: (identifier) @local.definition.function)

; Method parameters are definitions
(param
  name: (identifier) @local.definition.parameter)

; State machine names are definitions
(state_machine
  name: (identifier) @local.definition.field)

; State names are definitions
(state
  name: (identifier) @local.definition.constant)

; New construct definitions
(mixset_definition
  name: (identifier) @local.definition.type)

(association_class_definition
  name: (identifier) @local.definition.type)

(requirement_definition
  name: (identifier) @local.definition.type)

(statemachine_definition
  name: (identifier) @local.definition.field)

(referenced_statemachine
  name: (identifier) @local.definition.field)

(emit_method
  name: (identifier) @local.definition.function)

(template_attribute
  name: (identifier) @local.definition.field)

; =============
; REFERENCES
; =============

; isA references types
(isa_declaration
  (type_list
    (type_name
      (qualified_name) @local.reference)))

; Type usage references types
(type_name
  (qualified_name) @local.reference)

; Transition targets reference states
(transition
  target: (identifier) @local.reference)

; Inline association references classes
(association_inline
  right_type: (identifier) @local.reference)

; Association member types reference classes
(association_member
  left_type: (identifier) @local.reference)

(association_member
  right_type: (identifier) @local.reference)

; Single association end type references classes
(single_association_end
  type: (identifier) @local.reference)

; Standalone transition references states
(standalone_transition
  from_state: (identifier) @local.reference)

(standalone_transition
  to_state: (identifier) @local.reference)

; Referenced statemachine references a statemachine definition
(referenced_statemachine
  definition: (identifier) @local.reference)
