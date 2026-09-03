; ReScript tags for graft's generic breadth tier — the standard tree-sitter tags
; convention (@definition.<kind> + @name, @reference.call + @name), written against
; tree-sitter-rescript v6 (rescript-lang/tree-sitter-rescript), which ships no
; tags.scm of its own. No editor predicates are used, so generic.ts's sanitizer has
; nothing to strip here.
;
; Two things shape every pattern below.
;
; 1. Only MODULE-LEVEL bindings are definitions. A `let` inside a function body is a
;    local, and ReScript code is nothing but nested lets — indexing them would bury
;    each file's API under its implementation (the call Dart's query makes, #134).
;    Module level means a direct child of the file, of a `module X = { … }` body or
;    signature, or of a functor body. The grammar gives all of those the same `block`
;    node a function body gets, so each `let` shape is spelled once per parent instead
;    of once under a `(block …)` that would also match every function.
;
; 2. Two patterns must not capture one node under two kinds unless the narrower comes
;    FIRST and both complete on the same step: generic.ts keeps the first definition
;    minted per source span, and tree-sitter yields matches that finish on the same node
;    in pattern order — but a wider pattern that finishes a node EARLIER wins regardless
;    of where it is listed (a bare `(type_annotation (_))` twin of
;    `(type_annotation (function_type))` did exactly that). So a function-valued `let`
;    is told from a plain one by its `body:` field (same step, listed first), and a
;    signature or `external` by whether its type text has an arrow: two predicates,
;    disjoint by construction, no ordering to get wrong.

;; ---- let: a function-valued binding is a function, anything else a constant ------
;; A signature (`let f: int => int` in a .resi or a module type) has a type and no body.

; top level
(source_file
  (let_declaration
    (let_binding pattern: (value_identifier) @name body: (function)) @definition.function))
(source_file
  (let_declaration
    (let_binding pattern: (value_identifier) @name body: (_)) @definition.constant))
(source_file
  (let_declaration
    (let_binding pattern: (value_identifier) @name (type_annotation) @type !body (#match? @type "=>")) @definition.function))
(source_file
  (let_declaration
    (let_binding pattern: (value_identifier) @name (type_annotation) @type !body (#not-match? @type "=>")) @definition.constant))

; `module X = { … }` body
(module_binding definition: (block
  (let_declaration
    (let_binding pattern: (value_identifier) @name body: (function)) @definition.function)))
(module_binding definition: (block
  (let_declaration
    (let_binding pattern: (value_identifier) @name body: (_)) @definition.constant)))
(module_binding definition: (block
  (let_declaration
    (let_binding pattern: (value_identifier) @name (type_annotation) @type !body (#match? @type "=>")) @definition.function)))
(module_binding definition: (block
  (let_declaration
    (let_binding pattern: (value_identifier) @name (type_annotation) @type !body (#not-match? @type "=>")) @definition.constant)))

; `module X: { … }` signature (an interface file's nested modules)
(module_binding signature: (block
  (let_declaration
    (let_binding pattern: (value_identifier) @name (type_annotation) @type !body (#match? @type "=>")) @definition.function)))
(module_binding signature: (block
  (let_declaration
    (let_binding pattern: (value_identifier) @name (type_annotation) @type !body (#not-match? @type "=>")) @definition.constant)))

; functor body: `module Make = (M: S) => { … }`
(functor body: (block
  (let_declaration
    (let_binding pattern: (value_identifier) @name body: (function)) @definition.function)))
(functor body: (block
  (let_declaration
    (let_binding pattern: (value_identifier) @name body: (_)) @definition.constant)))

;; ---- types, modules, externals, exceptions ------------------------------------------

(type_binding name: (type_identifier) @name) @definition.type
(type_binding name: (type_identifier_path (type_identifier) @name)) @definition.type

; `module type S = { … }` is a signature — an interface — before the plain module fallback
(module_declaration "type"
  (module_binding name: [(module_identifier) (type_identifier)] @name) @definition.interface)
(module_binding name: [(module_identifier) (type_identifier)] @name) @definition.module

; `external f: int => int = "f"` binds a JS function; `external x: t = "x"` a value
(external_declaration (value_identifier) @name (type_annotation) @type (#match? @type "=>")) @definition.function
(external_declaration (value_identifier) @name (type_annotation) @type (#not-match? @type "=>")) @definition.constant

(exception_declaration (variant_identifier) @name) @definition.type

;; ---- calls ----------------------------------------------------------------------------
;; The bare name is what resolve.ts matches: same-file first, else a unique repo-wide
;; definition; an ambiguous name is dropped rather than guessed. `Mod.f(x)` keeps only
;; `f` — the module is a file, and generic.ts turns it into a file→file import instead.

(call_expression function: (value_identifier) @name) @reference.call
(call_expression function: (value_identifier_path (value_identifier) @name)) @reference.call

; `x->f` / `x->Mod.f` pipes `x` into a call. With parens (`x->f(y)`) the right-hand side
; is a call_expression the patterns above see; without, the callee is the pipe's last child.
(pipe_expression (value_identifier) @name .) @reference.call
(pipe_expression (value_identifier_path (value_identifier) @name) .) @reference.call
