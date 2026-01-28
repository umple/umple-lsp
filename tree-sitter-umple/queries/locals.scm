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
