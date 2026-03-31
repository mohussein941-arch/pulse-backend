/**
 * Health score engine — mirrors the frontend calcHealth() exactly.
 * Keeping this in the backend means synced accounts get accurate scores
 * calculated server-side before being saved to the database.
 */
const calcHealth = ({ nps = 50, ces = 3.5, productUsage = 60, openTickets = 0 }) => {
  const npsScore  = Math.round((Math.min(100, Math.max(0, nps)) / 100) * 25);
  const cesScore  = Math.round((Math.min(5,   Math.max(1, ces)) / 5)   * 25);
  const useScore  = Math.round((Math.min(100, Math.max(0, productUsage)) / 100) * 25);
  const tixScore  = Math.round(Math.max(0, 1 - openTickets / 10) * 15);
  const base      = 10;

  const total = Math.min(100, Math.max(0, npsScore + cesScore + useScore + tixScore + base));
  const stage =
    total >= 70 ? "Healthy" :
    total >= 55 ? "Stable"  :
    total >= 40 ? "Needs Attention" :
                  "At Risk";

  return { healthScore: total, churnRisk: 100 - total, stage };
};

module.exports = { calcHealth };
