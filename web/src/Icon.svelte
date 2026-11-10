<script lang="ts">
  let { name, size = 20 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    sms: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z',
    accounts: 'M3 6h18v14H3z M3 10h18 M7 15h4 M5 6V3h14v3',
    merchants:
      'm3 9 2-6h14l2 6 M3 9v3a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0V9 M5 15v6h14v-6 M10 21v-6h4v6',
    templates:
      'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5',
    ai: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
    tasker:
      'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2 M10 18h4 M10 6h4',
    settings:
      'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2',
    arrow: 'M5 12h14 M13 6l6 6-6 6',
    down: 'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',
    trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
    plus: 'M12 5v14 M5 12h14',
    search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    check: 'm5 12 4 4L19 6',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8',
    logout: 'M9 21H4V3h5 M9 12h12 M16 7l5 5-5 5',
    menu: 'M4 6h16 M4 12h16 M4 18h16',
    close: 'm6 6 12 12 M6 18 18 6',
    refresh: 'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 2 M4 17l2 2a7 7 0 0 0 12-2',
    external: 'M14 3h7v7 M10 14 21 3 M21 14v7H3V3h7',
    shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z M8 12l3 3 5-6',
    clock: 'M12 6v6l4 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    filter: 'M4 5h16 M7 12h10 M10 19h4',
    chevron: 'm9 5 7 7-7 7',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.65"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name] ?? paths.overview} /></svg
>
