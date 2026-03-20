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
    [$.constraint, $.guard],
    [$.trace_statement, $.event_spec],
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
        $.require_statement,
        $.is_feature,
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
      prec.right(
        seq(
          "use",
          field("path", $.use_path),
          repeat(seq(",", field("path", $.use_path))),
          optional(";"),
        ),
      ),

    use_path: ($) => /[a-zA-Z0-9_.\/:\-][a-zA-Z0-9_.\/:\-]*/,

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
        optional($.trait_parameters),
        "{",
        repeat($._trait_content),
        "}",
      ),

    // Trait bodies accept everything class bodies accept, plus abstract method
    // signatures (semicolon-terminated) and nested trait definitions.
    _trait_content: ($) =>
      choice($._class_content, $.trait_method_signature, $.trait_definition),

    // Trait template parameters: <TP isA I1 & I2 = Default, TP2>
    // Official grammar: traitParameters, traitFullParameters, traitParametersInterface
    trait_parameters: ($) =>
      seq("<", $.trait_parameter, repeat(seq(",", $.trait_parameter)), ">"),

    trait_parameter: ($) =>
      seq(
        field("name", $.identifier),
        optional($.trait_parameter_constraint),
        optional(seq("=", field("default", $.qualified_name))),
      ),

    trait_parameter_constraint: ($) =>
      seq("isA", $.qualified_name, repeat(seq("&", $.qualified_name))),

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
        optional(field("language", $.req_language)),
        "{",
        optional(field("content", $.req_content)),
        "}",
      ),

    // Requirement language is a single token before "{". Verified compiler-valid
    // forms include bare identifiers, dotted/dashed names, and quoted one-token
    // names. Multi-word quoted strings are intentionally not accepted here.
    req_language: ($) =>
      token(
        choice(
          /[A-Za-z0-9_.-]+/,
          seq('"', /[^"\s{}]+/, '"'),
          seq("'", /[^'\s{}]+/, "'"),
        ),
      ),

    // Requirement content remains intentionally opaque. This only makes the body
    // brace-tolerant so compiler-valid nested text does not break indexing.
    req_content: ($) =>
      repeat1(choice(/[^\{\}]+/, seq("{", optional($.req_content), "}"))),

    // =====================
    // REQUIRE STATEMENT & IS_FEATURE
    // =====================
    // Feature dependency: require [M2]; require subfeature [A and B];
    // Body is opaque (same approach as constraint) — no semantic parsing.
    require_statement: ($) =>
      prec.right(
        seq(
          "require",
          optional("subfeature"),
          $.require_body,
          optional(";"),
        ),
      ),

    require_body: ($) => seq("[", repeat1($._require_expr), "]"),

    _require_expr: ($) =>
      choice(
        seq("{", repeat($._require_expr), "}"),
        seq("(", repeat($._require_expr), ")"),
        /[^\[\]\{\}\(\)]+/,
      ),

    // Feature marker: isFeature;
    is_feature: ($) => prec.right(seq("isFeature", optional(";"))),

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

    // Header for regular transitions inside a state body.
    // Guard-only is valid: [x>0] -> T; compiles cleanly.
    _transition_header: ($) =>
      choice(
        seq(field("event", $.event_spec), optional($.guard)), // e [g]?
        seq($.guard, optional(field("event", $.event_spec))), // [g] e?
      ),

    // Header for standalone transitions (SM body level).
    // Guard-only standalone ([x>0] Open -> Closed) is W1006 — event is always required.
    _standalone_transition_header: ($) =>
      choice(
        seq(field("event", $.event_spec), optional($.guard)), // e [g]?
        seq($.guard, field("event", $.event_spec)),           // [g] e  (event required)
      ),

    standalone_transition: ($) =>
      seq(
        $._standalone_transition_header,
        field("from_state", $.identifier),
        optional($.action_code),
        "->",
        optional($.action_code),
        field("to_state", $.identifier),
        ";",
      ),

    // Attribute: [unique]? [lazy]? [modifier]? [Type] name [= value];
    // Official grammar has fixed-order positional slots, not a free-form modifier bag.
    attribute_declaration: ($) =>
      seq(
        optional("unique"),
        optional("lazy"),
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

    // Modifier keywords for attributes. `unique` and `lazy` are separate positional
    // slots in the official grammar and live directly in `attribute_declaration`.
    // `autounique` is officially its own rule, kept here as a compatibility shortcut.
    attribute_modifier: ($) =>
      choice(
        "immutable",
        "settable",
        "internal",
        "defaulted",
        "const",
        "autounique",
      ),

    // =====================
    // INLINE ASSOCIATIONS
    // =====================
    association_inline: ($) =>
      seq(
        optional("immutable"),
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
        optional("immutable"),
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
        optional($._transition_header),
        choice(
          seq($.action_code, "->"), // pre-arrow only:  e [g] / { code } -> T;
          seq("->", $.action_code), // post-arrow only: e [g] -> / { code } T;
          "->",                     // no action:       e [g] -> T;
        ),
        field("target", $.qualified_name),
        ";",
      ),

    event_spec: ($) =>
      choice(
        $.timed_event,
        seq(
          choice(
            $.identifier,
            // activate/deactivate are valid event names but also trace keywords
            alias("activate", $.identifier),
            alias("deactivate", $.identifier),
          ),
          optional(seq("(", optional($.param_list), ")")),
        ),
      ),

    // Timed events: after(N), afterEvery(N), after(expr), afterEvery(getDelay())
    timed_event: ($) =>
      seq(
        field("keyword", alias(choice("after", "afterEvery"), $.identifier)),
        "(",
        field("time", $.timer_arg),
        ")",
      ),

    timer_arg: ($) =>
      repeat1(
        choice(
          $.identifier,
          /\d+(\.\d+)?/,
          /[+\-*\/]/,
          seq("(", optional($.timer_arg), ")"),
        ),
      ),

    guard: ($) => seq("[", repeat1($._constraint_expr), "]"),

    action_code: ($) =>
      seq("/", repeat1($.more_code)),

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

    // Semicolon-terminated method declaration for trait bodies only.
    // Two valid forms per compiler testing:
    //   1. Implicit abstract: return type required (e.g. void f();)
    //   2. Explicit abstract: keyword required, visibility optional
    //      (e.g. abstract f();  /  public abstract void f();)
    // Rejects: f();  public void f();  protected void f();  (all W1007)
    trait_method_signature: ($) =>
      choice(
        // Branch 1: implicit abstract — return type required
        seq(
          field("return_type", $.type_name),
          field("name", $.identifier),
          "(",
          optional($.param_list),
          ")",
          ";",
        ),
        // Branch 2: explicit abstract — keyword required, visibility optional
        seq(
          optional(choice("public", "protected")),
          "abstract",
          optional(field("return_type", $.type_name)),
          field("name", $.identifier),
          "(",
          optional($.param_list),
          ")",
          ";",
        ),
      ),

    visibility: ($) => choice("public", "private", "protected"),

    param_list: ($) => seq($.param, repeat(seq(",", $.param))),

    param: ($) => seq($.type_name, field("name", $.identifier)),

    before_after: ($) =>
      seq(
        choice("before", "after"),
        seq($.identifier, optional("*")),
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
        optional(
          seq("<", $._type_argument, repeat(seq(",", $._type_argument)), ">"),
        ),
        optional("[]"),
      ),

    // Each angle-bracket argument is either a regular type, a trait binding,
    // or a trait SM binding.  trait_binding requires "=", trait_sm_binding
    // requires "as", so <X> unambiguously resolves to type_name.
    _type_argument: ($) =>
      choice($.trait_binding, $.trait_sm_binding, $.type_name),

    // Trait parameter application: TP = ClassName (inside <> of isA type)
    trait_binding: ($) =>
      seq(field("param", $.identifier), "=", field("value", $.qualified_name)),

    // Trait SM injection: sm1 as sm.s2 (Extending a State)
    trait_sm_binding: ($) =>
      seq(field("param", $.identifier), "as", field("value", $.qualified_name)),

    type_list: ($) => seq($.type_name, repeat(seq(",", $.type_name))),

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
