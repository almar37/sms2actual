import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const xml = readFileSync(new URL('../tasker/Actual_SMS_Inbox.prj.xml', import.meta.url), 'utf8');
const decode = (value: string) =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
const task = xml.match(/<Task sr="task10">([\s\S]*?)<\/Task>/u)![1]!;
const action = (id: number) =>
  task.match(new RegExp(`<Action sr="act${id}"[^>]*>([\\s\\S]*?)<\\/Action>`, 'u'))![1]!;
const arg = (id: number, field: number) =>
  decode(action(id).match(new RegExp(`<Str sr="arg${field}"[^>]*>([\\s\\S]*?)<\\/Str>`, 'u'))![1]!);

function phone() {
  const context: Record<string, unknown> = {
    http_response_code: '200',
    http_data: JSON.stringify({
      checkpoint: { date: 1000, rowId: 0 },
      senders: ['SAB'],
      senderFilter: "LOWER(TRIM(address)) IN ('sab')",
    }),
    flashLong: (message: string) => {
      throw new Error(message);
    },
    exit: () => {
      throw new Error('Tasker stopped');
    },
    setLocal: (key: string, value: string) => {
      context[key.slice(1)] = value;
    },
  };
  runInNewContext(arg(2, 0), context);
  return context;
}

describe('Tasker phone-side inbox filtering', () => {
  it('executes the exported content-provider selection against mixed SMS rows', () => {
    const context = phone();
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE sms(_id INTEGER,address TEXT,body TEXT,date INTEGER)');
      const insert = db.prepare('INSERT INTO sms VALUES(?,?,?,?)');
      insert.run(1, 'Private contact', 'Private message with SAB in its body', 1001);
      insert.run(2, 'AlRajhiBank', 'Unconfigured bank', 1002);
      insert.run(3, ' sAb ', 'Selected bank message', 1003);
      insert.run(4, 'SAB', 'Before checkpoint', 999);
      const selection = arg(3, 4).replace(
        /%(syncdate|syncid|senderfilter)/gu,
        (_match, key: string) => String(context[key]),
      );
      const rows = db
        .prepare(`SELECT ${arg(3, 3)} FROM sms WHERE ${selection} ORDER BY ${arg(3, 6)}`)
        .all();
      expect(rows).toEqual([
        { _id: 3, address: ' sAb ', body: 'Selected bank message', date: 1003 },
      ]);
    } finally {
      db.close();
    }
  });
  it.each(['|~sms~|', ','])(
    'never uploads unselected content even if the provider returns it with divider %j',
    (divider) => {
      const context = phone();
      context.inboxrows = [
        ['1', 'Personal Contact', 'Personal secrets, not a bank message', 1001].join(divider),
        ['2', 'AlRajhiBank', 'Other bank secrets', 1002].join(divider),
        ['3', 'sAb', 'Transaction, with comma\nand newline', 1003].join(divider),
      ];
      context.syncdate = '1000';
      context.syncid = '0';
      runInNewContext(arg(4, 0), context);
      const payload = JSON.parse(String(context.payload));
      expect(payload.rows).toEqual([
        { rowId: '1', date: '1001', sender: null, message: null },
        { rowId: '2', date: '1002', sender: null, message: null },
        {
          rowId: '3',
          date: '1003',
          sender: 'sAb',
          message: 'Transaction, with comma\nand newline',
        },
      ]);
      expect(String(context.payload)).not.toMatch(/Personal|secrets|AlRajhiBank/u);
    },
  );
  it('fails closed if the sender allowlist is missing', () => {
    const context = phone();
    context.http_data = JSON.stringify({
      checkpoint: { date: 1000, rowId: 0 },
      senderFilter: '1=1',
    });
    expect(() => runInNewContext(arg(2, 0), context)).toThrow(/bank sender filter/u);
    expect(context.payload).toBeUndefined();
  });
});
