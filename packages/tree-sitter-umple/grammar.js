/**
 * @file Tree-sitter grammar for Umple modeling language
 * @author Umple LSP Team
 * @license MIT
 *
 * This is a simplified grammar focusing on symbol extraction for go-to-definition.
 * It parses the most common Umple constructs without trying to handle every edge case.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: "umple",

  extras: ($) => [/\s/, $.line_comment, $.block_comment],

  word: ($) => $.identifier,

  conflicts: ($) => [
    [$._definition, $._class_content],
    [$.multiplicity, $.state],
    [$.event_spec, $.qualified_name],
    [$._class_content, $.mixset_definition],
    [$.state_machine, $.state],
    [$.event_spec, $.method_declaration],
  ],

  rules: {
    source_file: ($) => repeat($._definition),

    _definition: ($) =>
      choice(
        $.namespace_declaration,
        $.use_statement,
        $.generate_statement,
        $.filter_definition,
        $.class_definition,
        $.interface_definition,
        $.trait_definition,
        $.association_definition,
        $.external_definition,
        $.enum_definition,
        $.requirement_definition,
        $.mixset_definition,
        $.association_class_definition,
        $.statemachine_definition,
        $.toplevel_code_injection,
      ),

    // =====================
    // NAMESPACE & USE
    // =====================
    namespace_declaration: ($) =>
      seq("namespace", field("name", $.qualified_name), ";"),

    use_statement: ($) =>
      prec.right(seq("use", field("path", $.use_path), optional(";"))),

    use_path: ($) => /[a-zA-Z0-9_.\/][a-zA-Z0-9_.\/]*/,

    generate_statement: ($) =>
      seq(
        "generate",
        field("language", choice(
          "Java", "Nothing", "Php", "RTCpp", "SimpleCpp", "Ruby", "Python",
          "Cpp", "Json", "StructureDiagram", "Yuml", "Violet", "Umlet",
          "Simulate", "TextUml", "Scxml", "GvStateDiagram", "GvClassDiagram",
          "GvFeatureDiagram", "GvClassTraitDiagram", "GvEntityRelationshipDiagram",
          "Alloy", "NuSMV", "NuSMVOptimizer", "Papyrus", "Ecore", "Xmi",
          "Xtext", "Sql", "StateTables", "EventSequence", "InstanceDiagram",
          "Umple", "UmpleSelf", "USE", "Test", "SimpleMetrics",
          "PlainRequirementsDoc", "Uigu2", "ExternalGrammar", "Mermaid",
        )),
        optional(field("path", $.string_literal)),
        optional(field("override", choice("--override-all", "--override"))),
        repeat(seq(
          choice("-s", "--suboption"),
          field("suboption", $.string_literal),
        )),
        ";",
      ),

    // =====================
    // CLASS DEFINITION
    // =====================
    class_definition: ($) =>
      seq(
        "class",
        field("name", $.identifier),
        "{",
        repeat($._class_content),
        "}",
      ),

    _class_content: ($) =>
      choice(
        $.isa_declaration,
        $.depend_statement,
        $.singleton,
        $.attribute_declaration,
        $.constraint,
        $.association_inline,
        $.state_machine,
        $.method_declaration,
        $.before_after,
        $.display_color,
        $.key_definition,
        $.abstract_declaration,
        $.immutable_declaration,
        $.symmetric_reflexive_association,
        $.req_implementation,
        $.class_definition,
        $.enum_definition,
        $.mixset_definition,
        $.referenced_statemachine,
        $.emit_method,
        $.template_attribute,
        $.active_definition,
        $.trace_statement,
        ";", // bare semicolons are valid in class/mixset bodies
      ),

    // Invariants: unnamed [expr]; and named [name: expr];
    // constraint_name consumes "identifier:" as a unit, so ":" is unambiguous
    // and the body _constraint_expr regex need not match it.
    constraint: ($) =>
      prec.right(
        seq(
          "[",
          optional(field("name", $.constraint_name)),
          field("body", repeat1($._constraint_expr)),
          "]",
          optional(";"),
        ),
      ),

    constraint_name: ($) => seq($.identifier, ":"),

    _constraint_expr: ($) =>
      choice(
        $.identifier,
        $.string_literal,
        $.number,
        $.boolean,
        /[^\]\s\w"':]+/, // operators and punctuation (: excluded — it is the name separator)
      ),

    // =====================
    // INTERFACE DEFINITION
    // =====================
    interface_definition: ($) =>
      seq(
        "interface",
        field("name", $.identifier),
        "{",
        repeat(
          choice(
            $.isa_declaration,
            $.depend_statement,
            $.method_signature,
            $.const_declaration,
          ),
        ),
        "}",
      ),

    // =====================
    // TRAIT DEFINITION
    // =====================
    trait_definition: ($) =>
      seq(
        "trait",
        field("name", $.identifier),
        optional($.type_parameters),
        "{",
        repeat($._class_content),
        "}",
      ),

    // =====================
    // EXTERNAL DEFINITION
    // =====================
    external_definition: ($) =>
      seq("external", field("name", $.identifier), "{", "}"),

    // =====================
    // ENUM DEFINITION
    // =====================
    enum_definition: ($) =>
      seq(
        "enum",
        field("name", $.identifier),
        "{",
        optional(
          seq(
            $.enum_value,
            repeat(seq(",", $.enum_value)),
            optional(","),
          ),
        ),
        "}",
      ),

    enum_value: ($) => field("name", $.identifier),

    // =====================
    // REQUIREMENT DEFINITION
    // =====================
    requirement_definition: ($) =>
      seq(
        "req",
        field("name", $.identifier),
        optional($.identifier),
        "{",
        optional(/[^}]*/),
        "}",
      ),

    // =====================
    // MIXSET DEFINITION
    // =====================
    mixset_definition: ($) =>
      seq(
        "mixset",
        field("name", $.identifier),
        "{",
        repeat(choice(
          $._definition,
          $._class_content,
          // State-level content (mixset bodies are context-free in real Umple)
          $.transition,
          $.entry_exit_action,
          $.do_activity,
          $.state,
          $.standalone_transition,
          $.display_color,
          "||",
        )),
        "}",
      ),

    // =====================
    // TRACE STATEMENTS
    // =====================
    // Parse-only support. Supported forms:
    //   trace entity [()]? postfix* ;
    //   tracecase name { trace entity [()]? postfix* ; ... }
    //   activate name (onAllObjects|onThisThreadOnly)? ;
    //   deactivate name onThisObject ;
    // Postfix: where/until/after/giving [condition], record entity
    // Deferred: execute { code }, prefix keywords (set/get/in/out etc.), logLevel/for/period/during
    trace_statement: ($) =>
      choice(
        seq(
          "trace",
          $.identifier,
          optional(seq("(", ")")),
          repeat($.trace_postfix),
          ";",
        ),
        seq(
          "tracecase",
          field("name", $.identifier),
          "{",
          repeat(seq(
            "trace",
            $.identifier,
            optional(seq("(", ")")),
            repeat($.trace_postfix),
            ";",
          )),
          "}",
        ),
        seq(
          "activate",
          $.identifier,
          optional(choice("onAllObjects", "onThisThreadOnly")),
          ";",
        ),
        seq("deactivate", $.identifier, "onThisObject", ";"),
      ),

    trace_postfix: ($) =>
      choice(
        seq(choice("where", "until", "after", "giving"), $.guard),
        seq("record", $.identifier),
      ),

    // =====================
    // ASSOCIATION CLASS DEFINITION
    // =====================
    association_class_definition: ($) =>
      seq(
        "associationClass",
        field("name", $.identifier),
        "{",
        repeat(choice($._class_content, $.single_association_end)),
        "}",
      ),

    single_association_end: ($) =>
      seq(
        $.multiplicity,
        choice(
          // 3 identifiers: otherEndRoleName type roleName (reflexive)
          seq(
            field("other_end_role", $.identifier),
            field("type", $.identifier),
            field("role_name", $.identifier),
          ),
          // 1-2 identifiers: type roleName?
          seq(
            field("type", $.identifier),
            optional(field("role_name", $.identifier)),
          ),
        ),
        ";",
      ),

    // =====================
    // STANDALONE STATEMACHINE DEFINITION
    // =====================
    statemachine_definition: ($) =>
      seq(
        "statemachine",
        optional("queued"),
        optional("pooled"),
        field("name", $.identifier),
        "{",
        repeat(choice($.state, $.standalone_transition, $.mixset_definition)),
        "}",
      ),

    // =====================
    // REFERENCED STATEMACHINE
    // =====================
    referenced_statemachine: ($) =>
      seq(
        field("name", $.identifier),
        "as",
        field("definition", $.identifier),
        choice(
          seq(
            "{",
            repeat(
              choice($.state, $.standalone_transition, $.entry_exit_action),
            ),
            "}",
          ),
          ";",
        ),
      ),

    // =====================
    // CLASS MEMBERS
    // =====================
    isa_declaration: ($) => seq("isA", $.type_list, ";"),

    depend_statement: ($) =>
      seq("depend", field("package", $.import_path), ";"),

    import_path: ($) =>
      /[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*(\.\*)?/,

    singleton: ($) => seq("singleton", ";"),

    display_color: ($) =>
      seq(choice("displayColor", "displayColour"), $.string_literal, ";"),

    key_definition: ($) =>
      seq(
        "key",
        "{",
        optional(seq($.identifier, repeat(seq(",", $.identifier)))),
        "}",
      ),

    abstract_declaration: ($) => prec(1, seq("abstract", ";")),

    immutable_declaration: ($) => prec(1, seq("immutable", ";")),

    // active [codeLangs] [name]? moreCode+ — runs in its own thread on construction
    //
    // NOTE: comma-separated lang tags (e.g. active Java, Cpp { code }) are spec-valid
    // but crash the current compiler with E9100 (NullPointerException in analyzeActiveObject).
    // This is a known compiler bug. The grammar correctly accepts the spec-valid form.
    //
    // Two parse forms are used to avoid GLR ambiguity:
    //   Form A: active codeLangs name moreCode+  — prefix lang, name is required
    //   Form B: active [name] moreCode+           — no prefix lang; lang tags go inside moreCode
    //
    // After "active code_lang {" the lookahead { is unambiguous → Form B (lang is in more_code).
    // After "active code_lang identifier" the lookahead identifier is unambiguous → Form A.
    // "active Java { code }" → Form B: more_code = Java { code }
    // "active Cpp Worker { code }" → Form A: code_langs=Cpp, name=Worker
    active_definition: ($) =>
      choice(
        // Form A: explicit prefix lang tag followed by a thread name
        seq("active", $.code_langs, field("name", $.identifier), repeat1($.more_code)),
        // Form B: optional thread name; any lang tags live inside moreCode blocks
        seq("active", optional(field("name", $.identifier)), repeat1($.more_code)),
      ),

    symmetric_reflexive_association: ($) =>
      seq($.multiplicity, "self", field("role", $.identifier), ";"),

    req_implementation: ($) =>
      seq(
        "implementsReq",
        $.identifier,
        repeat(seq(",", $.identifier)),
        ";",
      ),

    standalone_transition: ($) =>
      seq(
        field("event", $.event_spec),
        optional($.guard),
        field("from_state", $.identifier),
        optional($.action_code),
        "->",
        optional($.action_code),
        field("to_state", $.identifier),
        ";",
      ),

    // Attribute: [modifier] [Type] name [= value];
    attribute_declaration: ($) =>
      seq(
        optional($.attribute_modifier),
        optional(field("type", $.type_name)),
        field("name", $.identifier),
        optional(seq("=", $._value)),
        ";",
      ),

    const_declaration: ($) =>
      seq(
        "const",
        field("type", $.type_name),
        field("name", $.identifier),
        "=",
        $._value,
        ";",
      ),

    attribute_modifier: ($) =>
      choice(
        "lazy",
        "settable",
        "internal",
        "defaulted",
        "immutable",
        "autounique",
        "unique",
        "const",
      ),

    // =====================
    // INLINE ASSOCIATIONS
    // =====================
    association_inline: ($) =>
      seq(
        $.multiplicity,
        optional(field("left_role", $.identifier)),
        $.arrow,
        $.multiplicity,
        field("right_type", $.identifier),
        optional(field("right_role", $.identifier)),
        ";",
      ),

    multiplicity: ($) => choice("*", /\d+/, /\d+\.\.\d+/, /\d+\.\.\*/),

    arrow: ($) => choice("--", "->", "<-", "<@>-", "-<@>", ">->", "<-<"),

    // =====================
    // STANDALONE ASSOCIATIONS
    // =====================
    association_definition: ($) =>
      seq(
        "association",
        optional(field("name", $.identifier)),
        "{",
        repeat($.association_member),
        "}",
      ),

    association_member: ($) =>
      seq(
        $.multiplicity,
        field("left_type", $.identifier),
        optional(field("left_role", $.identifier)),
        $.arrow,
        $.multiplicity,
        field("right_type", $.identifier),
        optional(field("right_role", $.identifier)),
        ";",
      ),

    // =====================
    // STATE MACHINES
    // =====================
    state_machine: ($) =>
      seq(
        optional("queued"),
        optional("pooled"),
        field("name", $.identifier),
        "{",
        repeat(choice($.state, $.standalone_transition, $.mixset_definition, $.trace_statement)),
        "}",
      ),

    state: ($) =>
      seq(
        optional(field("change_type", choice("+", "-", "*"))),
        optional(field("is_final", "final")),
        field("name", $.identifier),
        "{",
        repeat(
          choice(
            $.transition,
            $.entry_exit_action,
            $.do_activity,
            $.state,
            $.standalone_transition,
            $.display_color,
            $.mixset_definition,
            $.method_declaration,
            $.trace_statement,
            "||",
            ";", // bare semicolons allowed in state bodies
          ),
        ),
        "}",
      ),

    transition: ($) =>
      seq(
        optional(field("event", $.event_spec)),
        optional($.guard),
        choice(
          seq($.action_code, "->"), // pre-arrow only:  e [g] / { code } -> T;
          seq("->", $.action_code), // post-arrow only: e [g] -> / { code } T;
          "->",                     // no action:       e [g] -> T;
        ),
        field("target", $.qualified_name),
        ";",
      ),

    event_spec: ($) =>
      seq($.identifier, optional(seq("(", optional($.param_list), ")"))),

    guard: ($) => seq("[", /[^\]]+/, "]"),

    action_code: ($) =>
      seq("/", choice(seq("{", optional($.code_content), "}"), $.identifier)),

    // code_lang / code_langs: optional target-language tags on code blocks
    // e.g. entry / Java { ... }  or  entry / Java, Cpp { ... }
    code_lang: ($) =>
      choice(
        "Java", "RTCpp", "SimpleCpp", "Cpp", "Php",
        "Ruby", "Python", "Alloy", "UmpleSelf",
      ),

    code_langs: ($) => seq($.code_lang, repeat(seq(",", $.code_lang))),

    // moreCode in official grammar: codeLangs? { code }
    more_code: ($) =>
      seq(optional($.code_langs), "{", optional($.code_content), "}"),

    entry_exit_action: ($) =>
      seq(choice("entry", "exit"), optional($.guard), "/", repeat1($.more_code)),

    do_activity: ($) => seq("do", repeat1($.more_code)),

    // =====================
    // METHODS
    // =====================
    method_declaration: ($) =>
      seq(
        optional($.visibility),
        optional("static"),
        optional(field("return_type", $.type_name)),
        field("name", $.identifier),
        "(",
        optional($.param_list),
        ")",
        optional($.identifier), // language tag
        "{",
        optional($.code_content),
        "}",
      ),

    method_signature: ($) =>
      seq(
        optional($.visibility),
        optional("static"),
        optional(field("return_type", $.type_name)),
        field("name", $.identifier),
        "(",
        optional($.param_list),
        ")",
        ";",
      ),

    visibility: ($) => choice("public", "private", "protected"),

    param_list: ($) => seq($.param, repeat(seq(",", $.param))),

    param: ($) => seq($.type_name, field("name", $.identifier)),

    before_after: ($) =>
      seq(
        choice("before", "after"),
        $.identifier,
        optional(seq("(", optional($.param_list), ")")),
        "{",
        optional($.code_content),
        "}",
      ),

    // =====================
    // EMIT METHODS & TEMPLATE ATTRIBUTES
    // =====================
    template_attribute: ($) =>
      seq(field("name", $.identifier), $.template_body),

    template_body: ($) =>
      token(seq("<<!", /([^!]|!([^>]|>[^>]))*/, "!>>")),

    emit_method: ($) =>
      seq(
        optional($.visibility),
        optional("static"),
        optional(field("return_type", $.type_name)),
        "emit",
        field("name", $.identifier),
        "(",
        optional($.param_list),
        ")",
        optional($.template_list),
        ";",
      ),

    template_list: ($) =>
      seq(
        "(",
        optional(
          seq(
            field("template_name", $.identifier),
            repeat(seq(",", field("template_name", $.identifier))),
          ),
        ),
        ")",
      ),

    // =====================
    // TOP-LEVEL CODE INJECTION (aspect-oriented)
    // =====================
    // before/after/around { ClassName, ... } operationName(params) { code }
    toplevel_code_injection: ($) =>
      seq(
        field("timing", choice("before", "after", "around")),
        "{",
        field("target", $.identifier),
        repeat(seq(",", field("target", $.identifier))),
        "}",
        optional(field("operation_source", choice("custom", "generated", "all"))),
        field("operation", $.identifier),
        optional(seq("(", optional($.param_list), ")")),
        "{",
        optional($.code_content),
        "}",
      ),

    code_content: ($) =>
      repeat1(choice(/[^{}]+/, seq("{", optional($.code_content), "}"))),

    // =====================
    // TYPES
    // =====================
    type_name: ($) =>
      seq(
        $.qualified_name,
        optional(seq("<", $.type_list, ">")),
        optional("[]"),
      ),

    type_list: ($) => seq($.type_name, repeat(seq(",", $.type_name))),

    type_parameters: ($) =>
      seq("<", $.identifier, repeat(seq(",", $.identifier)), ">"),

    // =====================
    // VALUES
    // =====================
    _value: ($) =>
      choice(
        $.number,
        $.string_literal,
        $.boolean,
        "null",
        $.qualified_name,
        $.new_expression,
        $.code_block,
      ),

    new_expression: ($) =>
      seq("new", $.qualified_name, "(", optional($._argument_list), ")"),

    _argument_list: ($) => seq($._value, repeat(seq(",", $._value))),

    code_block: ($) => seq("{", optional($.code_content), "}"),

    // =====================
    // FILTER DEFINITION
    // =====================
    // filter (name)? { (filterStatement)* }
    // Unnamed filter = active by default. Named filter = activated via includeFilter.
    // Note: filter names/references are not indexed as symbols (no definitions.scm entry).
    filter_definition: ($) =>
      seq(
        "filter",
        optional(field("name", $.filter_name)),
        "{",
        repeat($.filter_statement),
        "}",
      ),

    filter_name: ($) => choice($.identifier, $.integer_literal),

    filter_statement: ($) =>
      choice(
        $.filter_value,
        $.filter_combined_value,
        $.filter_namespace_stmt,
        $.filter_hops,
      ),

    // include ClassName, ~Excluded, Conn*;
    filter_value: ($) =>
      seq("include", $.filter_pattern, repeat(seq(",", $.filter_pattern)), ";"),

    // includeFilter 7, myFilter;
    filter_combined_value: ($) =>
      seq("includeFilter", $.filter_name, repeat(seq(",", $.filter_name)), ";"),

    // namespace com.example, other.ns;  (filter-local, not top-level namespace)
    filter_namespace_stmt: ($) =>
      seq(
        "namespace",
        $.qualified_name,
        repeat(seq(",", $.qualified_name)),
        ";",
      ),

    // hops { super 1; sub 2; association 1; }
    filter_hops: ($) =>
      seq(
        "hops",
        "{",
        repeat(
          choice(
            $.filter_hop_super,
            $.filter_hop_sub,
            $.filter_hop_association,
          ),
        ),
        "}",
      ),

    filter_hop_super:       ($) => seq("super",       $.integer_literal, ";"),
    filter_hop_sub:         ($) => seq("sub",         $.integer_literal, ";"),
    filter_hop_association: ($) => seq("association", $.integer_literal, ";"),

    // Class name or glob pattern: ClassName, Conn*, ~Excluded, ?Name
    filter_pattern: ($) => /~?[a-zA-Z0-9_.*?][a-zA-Z0-9_.*?]*/,

    integer_literal: ($) => /[0-9]+/,

    // =====================
    // BASIC TOKENS
    // =====================
    qualified_name: ($) =>
      prec.left(
        seq(
          $.identifier,
          repeat(
            seq(
              token.immediate("."),
              alias(token.immediate(/[a-zA-Z_][a-zA-Z0-9_]*/), $.identifier),
            ),
          ),
        ),
      ),

    identifier: ($) => /[a-zA-Z_][a-zA-Z0-9_]*/,

    number: ($) => /-?\d+(\.\d+)?/,

    string_literal: ($) => choice(/"[^"]*"/, /'[^']*'/),

    boolean: ($) => choice("true", "false"),

    // =====================
    // COMMENTS
    // =====================
    line_comment: ($) => token(seq("//", /[^\n]*/)),

    block_comment: ($) => token(seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/")),
  },
});
