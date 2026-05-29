export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startAuditRefreshScheduler } = await import('@/lib/audit-scheduler');
    startAuditRefreshScheduler();
  }
}
