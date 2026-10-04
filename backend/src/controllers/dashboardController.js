'use strict';

/** Aggregated dashboard statistics for the authenticated user. */

const { asyncHandler } = require('../middleware/validate');
const Job = require('../models/Job');
const Lead = require('../models/Lead');

const ACTIVE_STATUSES = ['queued', 'running'];

/** GET /api/dashboard/stats */
const stats = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [
    totalLeads,
    emailsFound,
    phonesFound,
    websitesFound,
    activeJobs,
    enrichedLeads,
    demoLeads,
    recentJobs,
    leadsByDay,
    topCategories,
    totalJobs,
  ] = await Promise.all([
    Lead.countDocuments({ user: userId }),
    Lead.countDocuments({ user: userId, email: { $ne: null } }),
    Lead.countDocuments({ user: userId, phone: { $ne: null } }),
    Lead.countDocuments({ user: userId, website: { $ne: null } }),
    Job.countDocuments({ user: userId, status: { $in: ACTIVE_STATUSES } }),
    Lead.countDocuments({ user: userId, enrichmentStatus: 'completed' }),
    Lead.countDocuments({ user: userId, demoData: true }),
    Job.find({ user: userId }).sort({ createdAt: -1 }).limit(5),
    Lead.aggregate([
      { $match: { user: userId } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 14 },
      { $sort: { _id: 1 } },
    ]),
    Lead.aggregate([
      { $match: { user: userId, category: { $ne: null } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]),
    Job.countDocuments({ user: userId }),
  ]);

  const withEmailPct = totalLeads ? Math.round((emailsFound / totalLeads) * 100) : 0;
  const withPhonePct = totalLeads ? Math.round((phonesFound / totalLeads) * 100) : 0;
  const withWebsitePct = totalLeads ? Math.round((websitesFound / totalLeads) * 100) : 0;

  return res.json({
    totals: {
      leads: totalLeads,
      emails: emailsFound,
      phones: phonesFound,
      websites: websitesFound,
      activeJobs,
      enriched: enrichedLeads,
      demoData: demoLeads,
      jobs: totalJobs,
    },
    coverage: {
      emailPct: withEmailPct,
      phonePct: withPhonePct,
      websitePct: withWebsitePct,
    },
    leadsByDay: leadsByDay.map((row) => ({ date: row._id, count: row.count })),
    topCategories: topCategories.map((row) => ({ category: row._id, count: row.count })),
    recentJobs: recentJobs.map((job) => job.toJSON()),
  });
});

module.exports = { stats };