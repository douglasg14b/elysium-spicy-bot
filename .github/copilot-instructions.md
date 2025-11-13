# GitHub Copilot Instructions

## TypeScript Guidelines

### ❌ NEVER use `any` type

-   Don't cast as `any` to bypass TypeScript errors
-   Don't use `: any` or `as any`

### ✅ Use proper types instead:

-   Define interfaces and types
-   Use specific type assertions (`as HTMLInputElement`)
-   Use union types (`'pending' | 'completed'`)
-   Use `unknown` instead of `any`
-   Create type guards when needed

Work WITH TypeScript's type system, not against it.
