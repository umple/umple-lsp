; Tree-sitter highlight queries for Umple
; Only uses node types that exist in the grammar

; =============
; KEYWORDS
; =============

[
  "class"
  "interface"
  "trait"
  "enum"
  "association"
  "external"
  "req"
  "mixset"
  "associationClass"
  "statemachine"
] @keyword.type

[
  "namespace"
  "use"
  "depend"
  "generate"
] @keyword.import

[
  "isA"
  "implementsReq"
] @keyword.modifier

[
  "abstract"
  "static"
  "const"
  "lazy"
  "settable"
  "internal"
  "defaulted"
  "immutable"
  "autounique"
  "unique"
  "singleton"
  "queued"
  "pooled"
] @keyword.modifier

[
  "public"
  "private"
  "protected"
] @keyword.modifier

[
  "before"
  "after"
  "emit"
] @keyword.directive

[
  "entry"
  "exit"
  "do"
] @keyword

[
  "new"
] @keyword.operator

[
  "displayColor"
  "displayColour"
  "key"
  "self"
] @keyword

; =============
; TYPES
; =============

(class_definition
  name: (identifier) @type.definition)

(interface_definition
  name: (identifier) @type.definition)

(trait_definition
  name: (identifier) @type.definition)

(enum_definition
  name: (identifier) @type.definition)

(external_definition
  name: (identifier) @type.definition)

(requirement_definition
  name: (identifier) @type.definition)

(mixset_definition
  name: (identifier) @type.definition)

(association_class_definition
  name: (identifier) @type.definition)

(type_name
  (qualified_name) @type)

(isa_declaration
  (type_list
    (type_name) @type))

; Built-in types
((identifier) @type.builtin
  (#any-of? @type.builtin
    "String"
    "Integer"
    "Float"
    "Double"
    "Boolean"
    "Date"
    "Time"
    "void"))

; =============
; FUNCTIONS
; =============

(method_declaration
  name: (identifier) @function)

(method_signature
  name: (identifier) @function)

(event_spec
  (identifier) @function.method)

(emit_method name: (identifier) @function)
(template_attribute name: (identifier) @variable.member)
(template_body) @string
(template_list template_name: (identifier) @variable.member)

; =============
; VARIABLES & PARAMETERS
; =============

(attribute_declaration
  name: (identifier) @variable.member)

(const_declaration
  name: (identifier) @constant)

(param
  name: (identifier) @variable.parameter)

; Key attributes
(key_definition
  (identifier) @variable.member)

; =============
; STATE MACHINES
; =============

(state_machine
  name: (identifier) @variable.member)

(statemachine_definition
  name: (identifier) @variable.member)

(referenced_statemachine
  name: (identifier) @variable.member)

(referenced_statemachine
  definition: (identifier) @type)

"as" @keyword

(state
  name: (identifier) @constant)

(transition
  target: (identifier) @constant)

; Standalone transition states
(standalone_transition
  from_state: (identifier) @constant)

(standalone_transition
  to_state: (identifier) @constant)

; =============
; ASSOCIATIONS
; =============

; Inline association type (e.g., "1 -- * Address addresses;")
(association_inline
  right_type: (identifier) @type)

(association_inline
  right_role: (identifier) @variable.member)

(association_inline
  left_role: (identifier) @variable.member)

; Standalone association types (e.g., "0..1 Mentor -- * Student;")
(association_member
  left_type: (identifier) @type)

(association_member
  right_type: (identifier) @type)

(association_member
  left_role: (identifier) @variable.member)

(association_member
  right_role: (identifier) @variable.member)

; Single association end (in associationClass)
(single_association_end
  type: (identifier) @type)

(single_association_end
  other_end_role: (identifier) @variable.member)

(single_association_end
  role_name: (identifier) @variable.member)

; Symmetric reflexive association
(symmetric_reflexive_association
  role: (identifier) @variable.member)

; =============
; NAMESPACE & IMPORTS
; =============

(namespace_declaration
  name: (qualified_name) @module)

(use_statement
  path: (_) @string.special.path)

(depend_statement
  package: (_) @module)

; =============
; OPERATORS & PUNCTUATION
; =============

[
  "->"
  "--"
  "<-"
  "<@>-"
  "-<@>"
  ">->"
  "<-<"
  "="
  "||"
] @operator

[
  ";"
  ","
  "."
] @punctuation.delimiter

[
  "{"
  "}"
  "("
  ")"
  "["
  "]"
  "<"
  ">"
] @punctuation.bracket

; Multiplicity
(multiplicity) @number

; =============
; LITERALS
; =============

(number) @number

(string_literal) @string

(boolean) @boolean

"null" @constant.builtin
"true" @boolean
"false" @boolean

; =============
; COMMENTS
; =============

(line_comment) @comment

(block_comment) @comment

; =============
; CONSTRAINTS
; =============

(constraint) @string.special
