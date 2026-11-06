/** Isolated browser smoke test: in-memory SQLite, fake Actual adapter, no external services. */
import { chromium, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { EventStore } from '../src/db.js';
import { ConsoleConfig } from '../src/console-config.js';
import { createConsoleAuth } from '../src/console-auth.js';
import { buildServer } from '../src/server.js';
import { NoopEnricher } from '../src/enricher.js';
import type { ActualAdapter, ResolvedConfig } from '../src/types.js';
import type { Processor } from '../src/processor.js';
import { ActualConnection } from '../src/actual-connection.js';
import { currentBudgetDate } from '../src/budget-date.js';
import { parseBankConfig } from '../src/config.js';
import { compileParserConfig } from '../src/parsing/config.js';
import YAML from 'yaml';

const origin = 'http://127.0.0.1:43123';
const setupKey = 'isolated-smoke-setup-key';
const banks = parseBankConfig(YAML.parse(readFileSync('config/banks.yaml', 'utf8')));
const parsing = compileParserConfig(YAML.parse(readFileSync('config/parsing.yaml', 'utf8')));
const store = new EventStore(':memory:');
const settings = new ConsoleConfig(store, 'isolated-smoke-secret-with-32-bytes');
const accounts = [
  { id: 'checking', name: 'Everyday account' },
  { id: 'savings', name: 'Rainy day fund' },
  { id: 'credit', name: 'Travel credit card' },
];
const categories = [
  { id: 'fees', name: 'Bank Fees' },
  { id: 'food', name: 'Food & coffee' },
  { id: 'groceries', name: 'Groceries' },
  { id: 'shopping', name: 'Shopping' },
];
const config: ResolvedConfig = {
  banks,
  parsing,
  accounts: accounts.map((a, i) => ({
    ...a,
    key: a.id,
    match: { bank: 'sab', accountSuffixes: [['1234', '4567', '5678'][i]!] },
  })),
  bankFeesCategoryId: 'fees',
  eligibleCategories: categories.filter((c) => c.id !== 'fees'),
};
settings.set('routing', {
  ...settings.seed(config),
  accounts: settings.seed(config).accounts.map((a) => ({
    ...a,
    type: a.id === 'credit' ? 'credit' : a.id === 'savings' ? 'savings' : 'checking',
    creditLimitCents: a.id === 'credit' ? 3000000 : undefined,
    fundingAccountId: a.id === 'credit' ? 'checking' : undefined,
  })),
});
settings.set('lastTaskerSync', new Date().toISOString());
const reviewTransferMessage =
  'حوالة محلية صادرةبـ200 SR\nمن1234\nلـ7001;Water Provider\nرسوم:0.29 SR\n26/11/6 14:08';
const reviewTransferEvent = store.enqueue({
  sender: 'SAB',
  message: reviewTransferMessage,
  receivedAt: '2026-11-06T14:10:00+03:00',
});
store.update(reviewTransferEvent.id, 'needs_review', { parserReason: 'unrecognized_template' });

for (let i = 0; i < 9; i++) {
  const input = {
    eventId: `demo-${i}`,
    sender: 'SAB',
    message:
      i === 0
        ? 'Unfamiliar bank message for review'
        : 'SAB purchase Card **1234 Amount SAR 25.00 at Coffee House',
    receivedAt: new Date().toISOString(),
  };
  const event = store.enqueue(input);
  store.update(
    event.id,
    i === 0 ? 'needs_review' : 'imported',
    i === 0
      ? { parserReason: 'unrecognized_template' }
      : {
          parsed: {
            bank: 'sab',
            kind: 'purchase',
            accountAlias: '1234',
            amountCents: -2500,
            feeCents: 0,
            payee: 'Coffee House',
            occurredAt: input.receivedAt,
            note: 'Synthetic browser fixture',
          },
        },
  );
}
const transferMessage = 'SAB outgoing transfer From: 1234 To: 4567 Amount: SAR 1';
const transferEvent = store.enqueue({
  sender: 'SAB',
  message: transferMessage,
  receivedAt: new Date().toISOString(),
});
store.update(transferEvent.id, 'imported', {
  parsed: {
    bank: 'sab',
    kind: 'transfer_out',
    accountAlias: '1234',
    transferCounterpartyAlias: '4567',
    amountCents: -100,
    feeCents: 0,
    payee: 'Bank transfer',
    occurredAt: new Date().toISOString(),
    note: 'Synthetic transfer fixture',
  },
});
let remoteRevision = 0,
  syncedRevision = 0,
  failNextSync = false;
const actual: ActualAdapter = {
  initialize: async () => {},
  shutdown: async () => {},
  serverVersion: async () => '26.9.0',
  sync: async () => {
    if (failNextSync) {
      failNextSync = false;
      throw new Error('Synthetic Actual outage');
    }
    syncedRevision = remoteRevision;
  },
  accounts: async () => accounts,
  categories: async () =>
    categories.map((category) =>
      category.id === 'food' && syncedRevision
        ? { ...category, name: 'Updated food category' }
        : category,
    ),
  accountBalance: async (id) =>
    (({ checking: 1854320, savings: 4200000, credit: -124850 })[id] ?? 0) +
    (id === 'checking' ? syncedRevision * 10000 : 0),
  transactions: async (id) => [
    ...(syncedRevision && id === 'checking'
      ? [
          {
            id: 'new-in-actual',
            accountId: id,
            date: currentBudgetDate(),
            payeeName: 'Updated from Actual',
            categoryId: 'food',
            amount: 10000,
          },
        ]
      : []),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `${id}-${i}`,
      accountId: id,
      date: `2026-11-${String(5 - i).padStart(2, '0')}`,
      payeeName: ['Coffee House', 'Weekend market', 'Bookshop', 'Salary'][i],
      categoryId: ['food', 'groceries', 'shopping', ''][i],
      amount: [-2500, -13475, -8900, 1500000][i],
    })),
  ],
  transferPayee: async () => '',
  importTransactions: async () => ({ added: [], updated: [], errors: [] }),
};
const connection = new ActualConnection(
  settings,
  config,
  '/unused',
  undefined,
  undefined,
  () => actual,
);
const auth = await createConsoleAuth(store, origin, 'isolated-smoke-auth-secret-with-32-bytes');
const app = buildServer({
  apiKey: setupKey,
  banks,
  store,
  processor: { tick: async () => {}, setMinConfidence: () => {} } as unknown as Processor,
  ready: () => true,
  console: {
    auth,
    settings,
    actual: connection,
    connection,
    requireSetupKey: false,
    config,
    publicUrl: origin,
    actualServerUrl: 'http://actual:5006',
    enricher: new NoopEnricher(),
  },
});
let browser;
try {
  await app.listen({ host: '127.0.0.1', port: 43123 });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    colorScheme: 'light',
  });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const artifactDir = process.env.WEB_SMOKE_ARTIFACT_DIR ?? '/tmp/sms2actual-web-smoke';
  await mkdir(artifactDir, { recursive: true });
  await page.goto(origin);
  await expect(page.getByLabel('Username')).toHaveCount(0);
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(page.getByLabel('Your name')).toHaveCount(0);
  await page.getByLabel('Password', { exact: true }).fill('testpass');
  await expect(page.getByLabel(/^API key/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Actual server connection' })).toBeVisible();
  await page.getByRole('link', { name: 'Tasker connection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inbox checkpoint' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save checkpoint', exact: true })).toBeEnabled();
  expect(store.inboxCheckpoint()).toBeUndefined();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Hard reset SMS & logs', exact: true }),
  ).toBeVisible();

  await page.getByLabel(/^Actual server URL/).fill('http://actual:5006');
  await page.getByLabel('Actual server password', { exact: true }).fill('fake-actual-password');
  await page.getByLabel(/^Budget Sync ID/).fill('fake-budget-id');
  await page.getByRole('button', { name: 'Connect Actual', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Actual connected');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Everything, in sync.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Everyday account' })).toBeVisible();
  await page.screenshot({
    path: `${artifactDir}/overview-light.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await page.screenshot({
    path: `${artifactDir}/overview-dark.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  remoteRevision = 1;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Budget refreshed from Actual');
  await expect(page.getByText('Updated from Actual', { exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Updated from Actual' })).toContainText(
    'Updated food category',
  );
  const checkingCard = page
    .locator('.holding-card')
    .filter({ has: page.getByRole('heading', { name: 'Everyday account', exact: true }) });
  await expect(checkingCard).toContainText(/18,643\.20/);
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  failNextSync = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not refresh from Actual');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByText('Updated from Actual', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Budget refreshed from Actual');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.getByRole('link', { name: 'Accounts & cards' }).click();
  await page.getByRole('button', { name: 'Add card', exact: true }).first().click();
  await page.getByLabel('Card name', { exact: true }).fill('Everyday debit');
  await page.getByLabel('Last digits', { exact: true }).fill('8888');
  await page.getByRole('button', { name: 'Save changes', exact: true }).first().click();
  await expect(page.getByRole('status')).toContainText('Accounts and cards saved');
  await page.screenshot({
    path: `${artifactDir}/accounts.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('link', { name: 'SMS inbox', exact: true }).click();
  await page.getByRole('button', { name: transferMessage, exact: true }).click();
  await expect(page.getByRole('combobox', { name: /^Counterparty account/ })).toHaveValue(
    'savings',
  );
  await expect(page.getByRole('button', { name: /Approve & import/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: reviewTransferMessage, exact: true }).click();
  const transferReview = page.getByRole('dialog', { name: 'Review message' });
  await expect(transferReview.getByRole('combobox', { name: /^Action/ })).toHaveValue(
    'transfer_out',
  );
  await expect(transferReview.getByRole('combobox', { name: /^Account/ })).toHaveValue('checking');
  await expect(transferReview.getByRole('spinbutton', { name: /^Amount/ })).toHaveValue('200');
  await expect(transferReview.getByRole('spinbutton', { name: /^Fees/ })).toHaveValue('0.29');
  await expect(transferReview.getByRole('spinbutton', { name: /^Fees/ })).toBeEnabled();
  await expect(transferReview.getByRole('textbox', { name: /^Payee/ })).toHaveValue(
    'Water Provider',
  );
  await expect(transferReview).toContainText('Source bank:');
  const transferCategory = transferReview.getByRole('combobox', { name: /^Category/ });
  await transferCategory.selectOption('food');
  const transferNotes = transferReview.getByRole('textbox', { name: /^Notes/ });
  await expect(transferNotes).toHaveValue('Reviewed in sms2actual');
  await transferNotes.fill('Water bill\nNovember 2026');
  await transferReview
    .getByRole('combobox', { name: /^Counterparty account/ })
    .selectOption('savings');
  await expect(transferCategory).toHaveCount(0);
  await expect(transferReview).toContainText('Fees use your Bank Fees category.');
  await transferReview.getByRole('combobox', { name: /^Counterparty account/ }).selectOption('');
  await expect(transferCategory).toHaveValue('food');
  await expect(transferReview).toContainText('Fees use the same category as this transaction.');
  await transferReview.getByRole('button', { name: /Approve & import/ }).click();
  await expect(page.getByRole('status')).toContainText('Review saved. Message queued for import.');
  const reviewedWater = JSON.parse(store.get(reviewTransferEvent.id)!.parsed!);
  expect(reviewedWater.note).toBe('Water bill\nNovember 2026');
  expect(reviewedWater.explicitTransferAccountId).toBeNull();
  await page.getByRole('button', { name: reviewTransferMessage, exact: true }).click();
  await expect(transferReview.getByRole('combobox', { name: /^Account/ })).toHaveValue('checking');
  await expect(transferCategory).toHaveValue('food');
  await expect(transferNotes).toHaveValue('Water bill\nNovember 2026');
  await page.screenshot({
    path: `${artifactDir}/external-transfer-review.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Unfamiliar bank message for review' }).click();
  await expect(page.getByRole('dialog', { name: 'Review message' })).toBeVisible();
  const review = page.getByRole('dialog', { name: 'Review message' });
  await review.getByRole('combobox', { name: /^Action/ }).selectOption('transfer_out');
  await review.getByRole('spinbutton', { name: /^Fees/ }).fill('1.50');
  await review.getByRole('combobox', { name: /^Action/ }).selectOption('refund');
  await expect(review.getByRole('spinbutton', { name: /^Fees/ })).toHaveValue('0');
  await expect(review.getByRole('spinbutton', { name: /^Fees/ })).toBeDisabled();
  await page.screenshot({
    path: `${artifactDir}/message-review.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: 'Merchants', exact: true }).click();
  await page.getByRole('button', { name: 'Add merchant' }).click();
  await page.getByLabel('Merchant text from SMS').fill('COFFEE HOUSE');
  await page.getByLabel('Display payee').fill('Coffee House');
  await page.getByRole('combobox', { name: /^Account/ }).selectOption('checking');
  await page.getByRole('combobox', { name: /^Category/ }).selectOption('food');
  await page.getByRole('button', { name: 'Save merchant' }).click();
  await expect(page.getByRole('table')).toContainText('Coffee House');
  await page.getByRole('link', { name: 'Message templates', exact: true }).click();
  await page.getByRole('button', { name: 'Create template', exact: true }).click();
  await page.getByLabel('SMS sender').fill('SAB');
  await page.getByLabel('Paste a reference message').fill('Purchase SAR 12.50 at Coffee card 1234');
  await page.getByLabel('Template name').fill('Everyday card purchase');
  await page
    .getByLabel('Message pattern')
    .fill('Purchase SAR {amount} at {merchant} card {suffix}');
  await page.getByRole('combobox', { name: /^Bank/ }).selectOption('sab');
  await page.getByRole('combobox', { name: /^Category/ }).selectOption('food');
  await page.getByRole('combobox', { name: /^Action/ }).selectOption('transfer_out');
  await expect(page.getByRole('combobox', { name: /^Category/ })).toHaveValue('food');
  await expect(page.getByRole('combobox', { name: /^Category/ })).toBeEnabled();
  await page.getByRole('combobox', { name: /^Action/ }).selectOption('purchase');
  await page.getByRole('button', { name: 'Test this example' }).click();
  await expect(page.getByText('It matches. Your template is ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Everyday card purchase' })).toBeVisible();
  await page.getByRole('link', { name: 'AI categorization', exact: true }).click();
  await page.getByRole('combobox', { name: /^Provider/ }).selectOption('openai');
  await page.getByLabel(/^API key/).fill('isolated-key-not-a-real-secret');
  await page.getByRole('combobox', { name: /^Model ID/ }).fill('test-model');
  await page.getByRole('button', { name: 'Save helper settings' }).click();
  await expect(page.getByRole('status')).toContainText('AI settings saved');
  await page.getByRole('link', { name: 'Tasker connection', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Start syncing from' })).toHaveValue('now');
  const saveCheckpoint = page.getByRole('button', { name: 'Save checkpoint', exact: true });
  await expect(saveCheckpoint).toBeEnabled();
  const beforeCheckpoint = Date.now();
  await saveCheckpoint.click();
  await expect(page.getByRole('status')).toContainText('Inbox checkpoint saved');
  expect(store.inboxCheckpoint()!.date).toBeGreaterThanOrEqual(beforeCheckpoint);
  expect(store.inboxCheckpoint()!.date).toBeLessThanOrEqual(Date.now());
  await page.getByRole('combobox', { name: 'Start syncing from' }).selectOption('custom');
  await page.getByLabel(/^Checkpoint date and time/).fill('2026-10-01T09:30:15');
  await saveCheckpoint.click();
  await expect(page.getByRole('status')).toContainText('Inbox checkpoint saved');
  const chosenCheckpoint = store.inboxCheckpoint()!;
  const browserTimestamp = await page.evaluate(() => new Date('2026-10-01T09:30:15').getTime());
  expect(chosenCheckpoint).toEqual({ date: browserTimestamp, rowId: 0 });
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Tasker connection', exact: true }).click();
  await expect(saveCheckpoint).toBeEnabled();
  expect(store.inboxCheckpoint()).toEqual(chosenCheckpoint);
  await page.screenshot({
    path: `${artifactDir}/tasker-checkpoint.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByLabel('Public service URL').fill('https://sms.example.test');
  await page.getByRole('button', { name: 'Replace credential' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Tasker project' }).click();
  expect((await download).suggestedFilename()).toBe('sms2actual.prj.xml');
  expect(store.inboxCheckpoint()).toEqual(chosenCheckpoint);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Active sessions' })).toBeVisible();
  await expect(page.getByLabel(/^Actual server URL/)).toHaveValue('http://actual:5006');
  await expect(page.getByRole('button', { name: 'Reconnect saved connection' })).toBeVisible();
  await expect(page.getByLabel('Browser URL for Actual')).toHaveCount(0);
  await page.screenshot({
    path: `${artifactDir}/settings.png`,
    fullPage: true,
    animations: 'disabled',
  });
  const messagesBeforeReset = store.list({ limit: 50 }).length;
  await page.getByRole('button', { name: 'Hard reset SMS & logs', exact: true }).click();
  const resetDialog = page.getByRole('dialog', { name: 'Reset SMS and logs', exact: true });
  const confirmReset = resetDialog.getByRole('button', {
    name: 'Permanently reset SMS and logs',
    exact: true,
  });
  await expect(confirmReset).toBeDisabled();
  await resetDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(store.list({ limit: 50 })).toHaveLength(messagesBeforeReset);
  await page.getByRole('button', { name: 'Hard reset SMS & logs', exact: true }).click();
  await resetDialog.getByLabel('Type RESET to confirm').fill('RESET');
  await page.screenshot({
    path: `${artifactDir}/reset-confirmation.png`,
    fullPage: true,
    animations: 'disabled',
  });
  const resetStarted = Date.now();
  await confirmReset.click();
  await expect(resetDialog).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText(`Cleared ${messagesBeforeReset} messages`);
  expect(store.list({ limit: 50 })).toEqual([]);
  expect(store.inboxCheckpoint()!.date).toBeGreaterThanOrEqual(resetStarted);
  expect(settings.templates()).toHaveLength(1);
  expect(settings.ai().provider).toBe('openai');
  await page.getByRole('link', { name: 'SMS inbox', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your inbox is ready.' })).toBeVisible();
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByText('Updated from Actual', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Current password').fill('testpass');
  await page.getByLabel(/^New password/).fill('newpass8');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByRole('status')).toContainText('Password updated');
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.topbar')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const notification = page.getByRole('button', { name: 'Dismiss notification' });
  if (await notification.isVisible()) await notification.click();
  await page.screenshot({
    path: `${artifactDir}/overview-mobile.png`,
    fullPage: true,
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  await menu.click();
  const mobileNavigation = page.getByRole('dialog', { name: 'Workspace navigation' });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.getByRole('link')).toHaveCount(9);
  await mobileNavigation.getByRole('link', { name: 'SMS inbox', exact: true }).click();
  await expect(mobileNavigation).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your inbox is ready.' })).toBeVisible();
  await menu.click();
  await page.keyboard.press('Escape');
  await expect(mobileNavigation).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await page.screenshot({ path: `${artifactDir}/mobile-sidebar.png`, animations: 'disabled' });
  await mobileNavigation.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(page.getByLabel('Username')).toHaveCount(0);
  await page.getByLabel('Password', { exact: true }).fill('newpass8');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await menu.click();
  await mobileNavigation.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Everything, in sync.' })).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    `Browser smoke passed: owner setup, login, account/card save, SMS review, merchant edit, template preview/save, AI settings, Tasker checkpoint selection/download, confirmed SMS/log reset, sessions, password change, password-only sign-in, logout, Actual refresh/recovery, themes and mobile layout. Screenshots: ${artifactDir}`,
  );
} finally {
  await browser?.close();
  await app.close();
  store.close();
}
