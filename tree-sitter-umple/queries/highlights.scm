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
] @keyword.directive

[
  "entry"
  "exit"
  "do"
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

; =============
; VARIABLES & PARAMETERS
; =============

(attribute_declaration
  name: (identifier) @variable.member)

(const_declaration
  name: (identifier) @constant)

(param
  name: (identifier) @variable.parameter)

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
