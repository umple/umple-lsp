; Tree-sitter highlight queries for Umple
; See :h treesitter-highlight-groups for standard capture names

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
] @keyword.type

[
  "namespace"
  "use"
  "depend"
  "generate"
] @keyword.import

[
  "isA"
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
  "mixset"
] @keyword.directive

[
  "entry"
  "exit"
  "do"
  "trace"
] @keyword

[
  "new"
] @keyword.operator

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

(type
  (qualified_name) @type)

(parameterized_type
  (identifier) @type)

(inline_association
  right_type: (identifier) @type)

(association_member
  left_type: (identifier) @type)

(association_member
  right_type: (identifier) @type)

(isa_declaration
  (identifier_list
    (identifier) @type))

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

(event
  (identifier) @function.method)

; =============
; VARIABLES & PARAMETERS
; =============

(attribute
  name: (identifier) @variable.member)

(const_attribute
  name: (identifier) @constant)

(derived_attribute
  name: (identifier) @variable.member)

(parameter
  name: (identifier) @variable.parameter)

; Role names in associations
(inline_association
  left_role: (identifier) @variable.member)

(inline_association
  right_role: (identifier) @variable.member)

(association_member
  left_role: (identifier) @variable.member)

(association_member
  right_role: (identifier) @variable.member)

; Enum values
(enum_values
  (identifier) @constant)

; =============
; STATE MACHINES
; =============

(state_machine
  name: (identifier) @variable.member)

(state
  name: (identifier) @constant)

(transition
  target: (identifier) @constant)

; =============
; NAMESPACE & IMPORTS
; =============

(namespace_declaration
  name: (qualified_name) @module)

(use_statement
  path: (_) @string.special.path)

(depend_statement
  package: (qualified_name) @module)

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
] @operator

[
  ";"
  ","
  "."
  ":"
] @punctuation.delimiter

[
  "{"
  "}"
] @punctuation.bracket

[
  "("
  ")"
] @punctuation.bracket

[
  "["
  "]"
] @punctuation.bracket

[
  "<"
  ">"
] @punctuation.bracket

; Multiplicity
(multiplicity) @number

(multiplicity_part) @number

"*" @number

".." @operator

; =============
; LITERALS
; =============

(number) @number

(string_literal) @string

(boolean_literal) @boolean

(null_literal) @constant.builtin

; =============
; COMMENTS
; =============

(line_comment) @comment

(block_comment) @comment

; =============
; CONSTRAINTS
; =============

(constraint) @string.special

(constraint_name
  (identifier) @label)

; =============
; LANGUAGE TAGS (Java, Python, etc.)
; =============

(method_declaration
  language: (identifier) @attribute)
