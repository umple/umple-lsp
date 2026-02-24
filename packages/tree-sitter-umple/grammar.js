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
    [$.event_spec, $.state],
    [$._definition, $._class_content],
  ],

  rules: {
    source_file: ($) => repeat($._definition),

    _definition: ($) =>
      choice(
        $.namespace_declaration,
        $.use_statement,
        $.generate_statement,
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
      seq("generate", field("language", $.identifier), ";"),

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
        $.symmetric_reflexive_association,
        $.req_implementation,
        $.class_definition,
        $.enum_definition,
        $.mixset_definition,
        $.referenced_statemachine,
        $.emit_method,
        $.template_attribute,
      ),

    // Constraints: [pre: condition], [name != ""], etc.
    constraint: ($) =>
      seq("[", repeat1($._constraint_expr), "]", optional(";")),

    _constraint_expr: ($) =>
      choice(
        $.identifier,
        $.string_literal,
        $.number,
        $.boolean,
        /[^\]\s\w"']+/, // operators and punctuation (: != >= <= && || etc.)
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
          seq($.identifier, repeat(seq(",", $.identifier)), optional(",")),
        ),
        "}",
      ),

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
        repeat(choice($._definition, $._class_content)),
        "}",
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
        repeat($.state),
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
        repeat(choice($.state, $.standalone_transition)),
        "}",
      ),

    state: ($) =>
      seq(
        field("name", $.identifier),
        optional(
          seq(
            "{",
            repeat(
              choice(
                $.transition,
                $.entry_exit_action,
                $.do_activity,
                $.state,
                "||",
              ),
            ),
            "}",
          ),
        ),
      ),

    transition: ($) =>
      seq(
        optional(field("event", $.event_spec)),
        optional($.guard),
        "->",
        optional($.action_code),
        field("target", $.identifier),
        ";",
      ),

    event_spec: ($) =>
      seq($.identifier, optional(seq("(", optional($.param_list), ")"))),

    guard: ($) => seq("[", /[^\]]+/, "]"),

    action_code: ($) =>
      seq("/", choice(seq("{", optional($.code_content), "}"), $.identifier)),

    entry_exit_action: ($) =>
      seq(choice("entry", "exit"), "/", "{", optional($.code_content), "}"),

    do_activity: ($) => seq("do", "{", optional($.code_content), "}"),

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
    // BASIC TOKENS
    // =====================
    qualified_name: ($) =>
      prec.left(seq($.identifier, repeat(seq(".", $.identifier)))),

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
