import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { escapeKqlIdentifier, escapeKqlString, sanitizeStringLiterals, scanKql, stripLeadingComments, validateIdentifier, validateQuerySafety, validateShowCommand, validateV2Query, ValidationError } from "../src/kql.mjs";

describe("validateQuerySafety (azure-mcp KqlQueryValidator port)", () => {
  const refused = [
    [".drop table T", /Management command '\.drop' is not allowed/],
    ["T | take 1; .drop table T", /'\.drop'/],
    ["T |\n\t.set-or-append X <| T", /'\.set'/],
    [".SET-OR-REPLACE X <| T", /'\.SET'/],
    ["  .execute database script <| .drop table T", /'\.execute'/],
    ["T | where a == 1 or 1==1", /tautology/],
    ["T | where a == 1 OR true", /tautology/],
    ["T | where a == 'x' or 'a'=='a'", /tautology/],
  ];
  for (const [query, pattern] of refused) {
    it(`refuses ${JSON.stringify(query)}`, () => {
      assert.throws(() => validateQuerySafety(query), (error) => error instanceof ValidationError && pattern.test(error.message) && error.status === 400);
    });
  }

  const allowed = [
    "StormEvents | take 10",
    "T | where Name == '.drop table T'",
    "T | where Text has '; .drop'",
    ".show tables",
    "T | extend x = 'or 1==1'",
  ];
  for (const query of allowed) {
    it(`allows ${JSON.stringify(query)}`, () => assert.doesNotThrow(() => validateQuerySafety(query)));
  }

  it("refuses empty and over-long queries", () => {
    assert.throws(() => validateQuerySafety("   "), /Query cannot be empty\./);
    assert.throws(() => validateQuerySafety("x".repeat(10_001)), /exceeds the maximum allowed limit of 10,000 characters/);
    assert.doesNotThrow(() => validateQuerySafety("x".repeat(10_000)));
  });
});

describe("identifiers", () => {
  it("escapes the way azure-mcp does", () => {
    assert.equal(escapeKqlIdentifier("StormEvents"), "['StormEvents']");
    assert.equal(escapeKqlIdentifier("['StormEvents']"), "['StormEvents']");
    assert.equal(escapeKqlIdentifier("it's"), "['it''s']");
    assert.throws(() => escapeKqlIdentifier("['']"), /empty after removing escape characters\. \(Parameter 'identifier'\)/);
    assert.equal(escapeKqlString("a\\b'c"), "a\\\\b''c");
  });

  it("validates like KustoIdentifierValidator", () => {
    assert.doesNotThrow(() => validateIdentifier("My Table-1.v2", "tableName"));
    assert.throws(() => validateIdentifier("T | take 1", "tableName"), /tableName contains invalid characters/);
    assert.throws(() => validateIdentifier("1abc", "tableName"), /not a valid Kusto identifier/);
    assert.throws(() => validateIdentifier("", "tableName"), /tableName cannot be empty/);
    assert.throws(() => validateIdentifier("a".repeat(1025), "tableName"), /exceeds maximum of 1024/);
  });
});

describe("sanitizeStringLiterals", () => {
  it("re-encodes single-quoted literals and leaves others alone", () => {
    assert.equal(sanitizeStringLiterals("T | where a == 'it''s'"), "T | where a == 'it''s'");
    assert.equal(sanitizeStringLiterals(`T | where a == "x'y" and b == @'c:\\d' and c == h'secret'`), `T | where a == "x'y" and b == @'c:\\d' and c == h'secret'`);
    assert.equal(sanitizeStringLiterals("T // it's a comment\n| take 1"), "T // it's a comment\n| take 1");
    assert.equal(sanitizeStringLiterals("print 'unterminated"), "print 'unterminated'");
  });
});

describe("validateShowCommand", () => {
  it("accepts one .show command, with comments and pipes", () => {
    assert.equal(validateShowCommand("// note\n  .show queries | where State == 'InProgress'"), ".show queries | where State == 'InProgress'");
    assert.equal(validateShowCommand(".SHOW tables"), ".SHOW tables");
  });

  it("refuses anything else", () => {
    assert.throws(() => validateShowCommand(".drop table T"), /Only \.show management commands/);
    assert.throws(() => validateShowCommand("T | take 1"), /Only \.show/);
    assert.throws(() => validateShowCommand(".show tables; .drop table T"), /Only one management command/);
    assert.throws(() => validateShowCommand(".show tables | .drop table T"), /'\.drop' is not allowed by kusto_command/);
    assert.throws(() => validateShowCommand(".showx"), /Only \.show/);
    assert.throws(() => validateShowCommand(".show-foo"), /Only \.show/);
    assert.throws(() => validateShowCommand(".show tables\n.drop table T"), /'\.drop'/);
    assert.doesNotThrow(() => validateShowCommand(".show table T details | where DocString has ';'"));
    assert.doesNotThrow(() => validateShowCommand(".show tables // a; b\n| take 1"));
    assert.doesNotThrow(() => validateShowCommand(".show tables | where TableName == ```a;b```"));
  });

  it("refuses string-boundary tricks that hide a second statement", () => {
    const tricks = [
      `.show tables | where TableName == "'" ; .drop table T ; print '"'`,
      `.show tables | where TableName == @"\\" ; .drop table T ; print "x"`,
      `.show tables | where TableName == h'x' ; .drop table T`,
      `.show tables | where A == 'it\\'s' ; .drop table T`,
      `.show tables | .alter table T policy retention "{}"`,
    ];
    for (const trick of tricks) assert.throws(() => validateShowCommand(trick), ValidationError, trick);
  });

  it("strips comment lines only at the start", () => {
    assert.equal(stripLeadingComments("// a\n// b\n.show x"), ".show x");
    assert.equal(stripLeadingComments("// only"), "");
  });
});

describe("scanKql and validateV2Query", () => {
  it("blanks literals and drops comments", () => {
    assert.equal(scanKql("T | where a == 'x;y' // c; d\n| take 1"), "T | where a == '' \n| take 1");
    assert.equal(scanKql('print @"a""b", h"s", ```m;l```'), "print '', '', ''");
    assert.equal(scanKql("print 'a\\'b'"), "print ''");
    assert.equal(scanKql("hello('x')"), "hello('')");
  });

  it("refuses control commands, allows .show and plain queries", () => {
    assert.throws(() => validateV2Query("T | take 1; .alter table T docstring 'x'"), /'\.alter'/);
    assert.throws(() => validateV2Query('print "\\"" ; .create table X (a:int)'), /not allowed/);
    assert.doesNotThrow(() => validateV2Query(".show tables"));
    assert.throws(() => validateV2Query(".show tables; .add database D viewers ('aadapp=x')"), /'\.add'/);
    assert.throws(() => validateV2Query(".show tables | .export to csv (h@'https://x') <| T"), /'\.export'/);
    assert.throws(() => validateV2Query(".show tables\n| .rename table A to B"), /'\.rename'/);
    assert.doesNotThrow(() => validateV2Query("declare query_parameters(n:long); T | take n"));
    assert.doesNotThrow(() => validateV2Query("T | where x > .5 and Name == '.drop'"));
  });
});
