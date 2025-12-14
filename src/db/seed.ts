import { db } from './index';
import { users, dailyStats } from './schema';
import { randomUUID } from 'crypto';

// Helper to generate random date within last N days
function getRandomDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split('T')[0];
}

// Helper to generate random number in range
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Seed data
async function seed() {
  console.log('Starting database seed...');

  // Clear existing data
  await db.delete(dailyStats);
  await db.delete(users);
  console.log('Cleared existing data');

  // Create fake users
  const fakeUsers = [
    {
      id: randomUUID(),
      githubId: '1234567',
      githubUsername: 'claude_master',
      displayName: 'Claude Master',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1234567',
      firstSessionDate: getRandomDate(90),
      createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    },
    {
      id: randomUUID(),
      githubId: '2345678',
      githubUsername: 'code_wizard',
      displayName: 'Code Wizard',
      avatarUrl: 'https://avatars.githubusercontent.com/u/2345678',
      firstSessionDate: getRandomDate(60),
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    },
    {
      id: randomUUID(),
      githubId: '3456789',
      githubUsername: 'dev_ops_pro',
      displayName: 'DevOps Pro',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3456789',
      firstSessionDate: getRandomDate(45),
      createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    },
    {
      id: randomUUID(),
      githubId: '4567890',
      githubUsername: 'ai_enthusiast',
      displayName: 'AI Enthusiast',
      avatarUrl: 'https://avatars.githubusercontent.com/u/4567890',
      firstSessionDate: getRandomDate(30),
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    },
    {
      id: randomUUID(),
      githubId: '5678901',
      githubUsername: 'fullstack_dev',
      displayName: 'Fullstack Dev',
      avatarUrl: 'https://avatars.githubusercontent.com/u/5678901',
      firstSessionDate: getRandomDate(20),
      createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    },
    {
      id: randomUUID(),
      githubId: '6789012',
      githubUsername: 'data_scientist',
      displayName: 'Data Scientist',
      avatarUrl: 'https://avatars.githubusercontent.com/u/6789012',
      firstSessionDate: getRandomDate(15),
      createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    },
    {
      id: randomUUID(),
      githubId: '7890123',
      githubUsername: 'backend_ninja',
      displayName: 'Backend Ninja',
      avatarUrl: 'https://avatars.githubusercontent.com/u/7890123',
      firstSessionDate: getRandomDate(10),
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    },
    {
      id: randomUUID(),
      githubId: '8901234',
      githubUsername: 'frontend_guru',
      displayName: 'Frontend Guru',
      avatarUrl: 'https://avatars.githubusercontent.com/u/8901234',
      firstSessionDate: getRandomDate(7),
      createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    },
  ];

  console.log(`Inserting ${fakeUsers.length} users...`);
  await db.insert(users).values(fakeUsers);

  // Generate daily stats for each user
  console.log('Generating daily stats...');
  const statsToInsert = [];

  for (const user of fakeUsers) {
    // Determine how many days of stats based on first session date
    const firstSessionDate = new Date(user.firstSessionDate!);
    const today = new Date();
    const daysDiff = Math.floor((today.getTime() - firstSessionDate.getTime()) / (1000 * 60 * 60 * 24));

    // Generate stats for random subset of days (not every day)
    const activeDays = Math.min(daysDiff, randomInt(5, 30));

    for (let i = 0; i < activeDays; i++) {
      const daysAgo = randomInt(0, daysDiff);
      const statDate = getRandomDate(daysAgo);

      // Varying activity levels
      const activityLevel = Math.random();
      let promptCount, messageCount, toolCallCount, tokenCount, linesWritten, commitCount;

      if (activityLevel < 0.2) {
        // Light day
        promptCount = randomInt(3, 10);
        messageCount = promptCount * 2; // Claude responds to each prompt
        toolCallCount = randomInt(10, 50);
        tokenCount = randomInt(10000, 100000); // 10K - 100K tokens
        linesWritten = randomInt(0, 200);
        commitCount = randomInt(0, 2);
      } else if (activityLevel < 0.6) {
        // Medium day
        promptCount = randomInt(10, 50);
        messageCount = promptCount * 2;
        toolCallCount = randomInt(50, 200);
        tokenCount = randomInt(100000, 500000); // 100K - 500K tokens
        linesWritten = randomInt(200, 1000);
        commitCount = randomInt(1, 5);
      } else {
        // Heavy day
        promptCount = randomInt(50, 250);
        messageCount = promptCount * 2;
        toolCallCount = randomInt(200, 1000);
        tokenCount = randomInt(500000, 2000000); // 500K - 2M tokens
        linesWritten = randomInt(1000, 5000);
        commitCount = randomInt(3, 15);
      }

      statsToInsert.push({
        userId: user.id,
        date: statDate,
        promptCount,
        messageCount,
        toolCallCount,
        tokenCount,
        linesWritten,
        commitCount,
        sessionCount: randomInt(1, 10), // Legacy
        submittedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
      });
    }
  }

  // Remove duplicates by user_id + date
  const uniqueStats = statsToInsert.reduce((acc, stat) => {
    const key = `${stat.userId}-${stat.date}`;
    if (!acc.has(key)) {
      acc.set(key, stat);
    }
    return acc;
  }, new Map());

  const finalStats = Array.from(uniqueStats.values());

  console.log(`Inserting ${finalStats.length} daily stats...`);
  if (finalStats.length > 0) {
    await db.insert(dailyStats).values(finalStats);
  }

  console.log('Seed completed successfully!');
  console.log(`- ${fakeUsers.length} users created`);
  console.log(`- ${finalStats.length} daily stats created`);

  process.exit(0);
}

seed().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
