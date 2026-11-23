// Syntax only: use the project's compiler; never load or execute project code.
export function typescriptOutline(ts, file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const symbols = [];
  const imports = new Set();
  const get = node => node?.getText(sf) || '';
  const add = (node, name, kind, scope, declaration) => {
    symbols.push({ name, kind, scope, exported: Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      end: sf.getLineAndCharacterOfPosition(node.end).line + 1, declaration: declaration.trim() });
  };
  const header = node => source.slice(node.getStart(sf), node.body ? node.body.getStart(sf) : node.end).trim();
  const qualify = (scope, name) => scope ? `${scope}.${name}` : name;
  function visit(node, scope = '', insideFunction = false) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const name = get(node.name) || '(default)';
      const declaration = source.slice(node.getStart(sf), node.members.pos).replace(/\{\s*$/, '');
      add(node, name, ts.isClassDeclaration(node) ? 'class' : 'interface', scope, declaration);
      for (const member of node.members) visit(member, qualify(scope, name), insideFunction);
      return;
    }
    if (ts.isTypeAliasDeclaration(node)) { add(node, get(node.name), 'type', scope, get(node)); return; }
    if (ts.isEnumDeclaration(node)) {
      add(node, get(node.name), 'enum', scope, `enum ${get(node.name)}`);
      for (const member of node.members) add(member, get(member.name), 'enum-member', qualify(scope, get(node.name)), get(member));
      return;
    }
    if (ts.isModuleDeclaration(node)) {
      add(node, get(node.name), 'namespace', scope, `namespace ${get(node.name)}`);
      if (node.body) visit(node.body, qualify(scope, get(node.name)), insideFunction);
      return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)
      || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
      || ts.isCallSignatureDeclaration(node) || ts.isConstructSignatureDeclaration(node) || ts.isIndexSignatureDeclaration(node)) {
      const name = get(node.name) || (ts.isConstructorDeclaration(node) ? 'constructor' : ts.isFunctionDeclaration(node) ? '(default)' : '(call)');
      add(node, name, ts.isFunctionDeclaration(node) ? 'function' : 'method', scope, header(node));
      if (node.body) visit(node.body, qualify(scope, name), true);
      return;
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) {
      const name = get(node.name);
      const value = node.initializer;
      if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
        const declaration = `${name}${node.type ? `: ${get(node.type)}` : ''} = ${header(value)}`;
        add(node, name, ts.isVariableDeclaration(node) ? 'function' : 'method', scope, declaration);
        visit(value.body, qualify(scope, name), true);
      } else if (!insideFunction || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
        const kind = ts.isVariableDeclaration(node) ? (node.parent.flags & ts.NodeFlags.Const ? 'constant' : 'variable') : 'property';
        const modifiers = node.modifiers?.map(get).join(' ');
        add(node, name, kind, scope,
          `${modifiers ? modifiers + ' ' : ''}${name}${node.questionToken ? '?' : ''}${node.type ? `: ${get(node.type)}` : ''}`);
      }
      // Named object methods are useful; ordinary local variables and anonymous callbacks are not indexed.
      if (value && ts.isObjectLiteralExpression(value)) {
        for (const member of value.properties) visit(member, qualify(scope, name), insideFunction);
      }
      return;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    ts.forEachChild(node, child => visit(child, scope, insideFunction));
  }
  visit(sf);
  return { symbols, imports: [...imports].sort(), diagnostics: sf.parseDiagnostics.map(d => ({
    line: sf.getLineAndCharacterOfPosition(d.start || 0).line + 1,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  })) };
}
