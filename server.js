import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Sequelize, DataTypes, Op } from 'sequelize';
import { google } from 'googleapis';
import bcrypt from 'bcryptjs';

const app = express();
const port = process.env.PORT || 5000;

const allowedOrigins = (process.env.CLIENT_URLS || process.env.CLIENT_URL || 'http://localhost:5173,http://localhost:5174')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    const isLocalDevOrigin = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || '');
    if (!origin || allowedOrigins.includes(origin) || isLocalDevOrigin) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  }
}));
app.use(express.json({ limit: '10mb' }));

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  dialect: process.env.DB_DIALECT || 'postgres',
  logging: false
});

const User = sequelize.define('User', {
  name: DataTypes.STRING,
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  passwordHash: { type: DataTypes.TEXT, allowNull: false },
  role: { type: DataTypes.STRING, defaultValue: 'Employee' },
  portalAccess: { type: DataTypes.STRING, defaultValue: 'user' },
  status: { type: DataTypes.STRING, defaultValue: 'Active' },
  mustChangePassword: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Candidate = sequelize.define('Candidate', {
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  phone: DataTypes.STRING,
  currentCompany: DataTypes.STRING,
  currentCtc: DataTypes.FLOAT,
  expectedCtc: DataTypes.FLOAT,
  noticePeriod: DataTypes.STRING,
  linkedin: DataTypes.TEXT,
  github: DataTypes.TEXT,
  roleApplied: DataTypes.STRING,
  experienceYears: DataTypes.FLOAT,
  skills: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
  cvUrl: DataTypes.TEXT,
  source: DataTypes.STRING,
  status: { type: DataTypes.STRING, defaultValue: 'In Library' },
  shortlistScore: { type: DataTypes.INTEGER, defaultValue: 0 },
  notes: DataTypes.TEXT
});

const JobDescription = sequelize.define('JobDescription', {
  title: { type: DataTypes.STRING, allowNull: false },
  department: DataTypes.STRING,
  location: DataTypes.STRING,
  employmentType: DataTypes.STRING,
  openings: { type: DataTypes.INTEGER, defaultValue: 1 },
  salaryMin: DataTypes.FLOAT,
  salaryMax: DataTypes.FLOAT,
  minExperience: DataTypes.FLOAT,
  requiredSkills: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
  responsibilities: DataTypes.TEXT,
  qualification: DataTypes.TEXT,
  reportingManager: DataTypes.STRING,
  approvalStatus: { type: DataTypes.STRING, defaultValue: 'Approved' },
  description: DataTypes.TEXT,
  status: { type: DataTypes.STRING, defaultValue: 'Open' }
});

const Panelist = sequelize.define('Panelist', {
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false },
  expertise: DataTypes.STRING,
  availability: DataTypes.STRING
});

const Interview = sequelize.define('Interview', {
  stage: { type: DataTypes.STRING, defaultValue: 'Technical' },
  scheduledAt: { type: DataTypes.DATE, allowNull: false },
  mode: { type: DataTypes.STRING, defaultValue: 'Video' },
  meetingLink: DataTypes.TEXT,
  teamsMeetingId: DataTypes.STRING,
  calendarProvider: { type: DataTypes.STRING, defaultValue: 'Google Calendar' },
  calendarStatus: { type: DataTypes.STRING, defaultValue: 'Pending Candidate Acceptance' },
  candidateResponse: { type: DataTypes.STRING, defaultValue: 'Awaiting Response' },
  status: { type: DataTypes.STRING, defaultValue: 'Scheduled' },
  feedback: DataTypes.TEXT,
  rating: DataTypes.INTEGER,
  decision: { type: DataTypes.STRING, defaultValue: 'Pending' }
});

const Offer = sequelize.define('Offer', {
  designation: DataTypes.STRING,
  annualCtc: DataTypes.FLOAT,
  joiningDate: DataTypes.DATEONLY,
  status: { type: DataTypes.STRING, defaultValue: 'Draft' },
  html: DataTypes.TEXT
});

const Employee = sequelize.define('Employee', {
  employeeCode: { type: DataTypes.STRING, unique: true },
  name: DataTypes.STRING,
  email: { type: DataTypes.STRING, unique: true },
  department: DataTypes.STRING,
  designation: DataTypes.STRING,
  joiningDate: DataTypes.DATEONLY,
  manager: DataTypes.STRING,
  salaryAnnual: DataTypes.FLOAT,
  status: { type: DataTypes.STRING, defaultValue: 'Active' },
  leaveBalance: { type: DataTypes.FLOAT, defaultValue: 24 }
});

const OnboardingTask = sequelize.define('OnboardingTask', {
  title: DataTypes.STRING,
  category: DataTypes.STRING,
  dueDate: DataTypes.DATEONLY,
  status: { type: DataTypes.STRING, defaultValue: 'Pending' },
  documentUrl: DataTypes.TEXT
});

const BgvCheck = sequelize.define('BgvCheck', {
  type: DataTypes.STRING,
  vendor: DataTypes.STRING,
  status: { type: DataTypes.STRING, defaultValue: 'Initiated' },
  remarks: DataTypes.TEXT,
  completedAt: DataTypes.DATE
});

const PayrollRun = sequelize.define('PayrollRun', {
  month: DataTypes.STRING,
  grossPay: DataTypes.FLOAT,
  deductions: DataTypes.FLOAT,
  reimbursements: DataTypes.FLOAT,
  netPay: DataTypes.FLOAT,
  status: { type: DataTypes.STRING, defaultValue: 'Draft' },
  creditedAt: DataTypes.DATE
});

const LeaveRequest = sequelize.define('LeaveRequest', {
  type: DataTypes.STRING,
  startDate: DataTypes.DATEONLY,
  endDate: DataTypes.DATEONLY,
  days: DataTypes.FLOAT,
  reason: DataTypes.TEXT,
  status: { type: DataTypes.STRING, defaultValue: 'Pending' }
});

const ExpenseClaim = sequelize.define('ExpenseClaim', {
  category: DataTypes.STRING,
  amount: DataTypes.FLOAT,
  spentOn: DataTypes.DATEONLY,
  description: DataTypes.TEXT,
  receiptUrl: DataTypes.TEXT,
  status: { type: DataTypes.STRING, defaultValue: 'Submitted' }
});

const RelievingCase = sequelize.define('RelievingCase', {
  resignationDate: DataTypes.DATEONLY,
  lastWorkingDate: DataTypes.DATEONLY,
  reason: DataTypes.TEXT,
  assetClearance: { type: DataTypes.STRING, defaultValue: 'Pending' },
  knowledgeTransfer: { type: DataTypes.STRING, defaultValue: 'Pending' },
  fullAndFinal: { type: DataTypes.STRING, defaultValue: 'Pending' },
  status: { type: DataTypes.STRING, defaultValue: 'In Progress' }
});

const AttendanceRecord = sequelize.define('AttendanceRecord', {
  date: DataTypes.DATEONLY,
  checkIn: DataTypes.STRING,
  checkOut: DataTypes.STRING,
  status: { type: DataTypes.STRING, defaultValue: 'Present' },
  workMode: { type: DataTypes.STRING, defaultValue: 'Office' },
  overtimeHours: { type: DataTypes.FLOAT, defaultValue: 0 }
});

const PerformanceReview = sequelize.define('PerformanceReview', {
  cycle: DataTypes.STRING,
  selfRating: DataTypes.FLOAT,
  managerRating: DataTypes.FLOAT,
  finalRating: DataTypes.FLOAT,
  status: { type: DataTypes.STRING, defaultValue: 'Manager Review' },
  recommendation: DataTypes.STRING
});

const GeneratedLetter = sequelize.define('GeneratedLetter', {
  type: DataTypes.STRING,
  status: { type: DataTypes.STRING, defaultValue: 'Generated' },
  html: DataTypes.TEXT
});

const FinalSettlement = sequelize.define('FinalSettlement', {
  pendingSalary: DataTypes.FLOAT,
  leaveEncashment: DataTypes.FLOAT,
  reimbursements: DataTypes.FLOAT,
  deductions: DataTypes.FLOAT,
  netPayable: DataTypes.FLOAT,
  status: { type: DataTypes.STRING, defaultValue: 'Pending' }
});

const Notification = sequelize.define('Notification', {
  title: DataTypes.STRING,
  body: DataTypes.TEXT,
  channel: { type: DataTypes.STRING, defaultValue: 'In-app' },
  status: { type: DataTypes.STRING, defaultValue: 'Unread' }
});

const MailLog = sequelize.define('MailLog', {
  to: DataTypes.TEXT,
  subject: DataTypes.STRING,
  html: DataTypes.TEXT,
  status: { type: DataTypes.STRING, defaultValue: 'Queued' },
  kind: DataTypes.STRING
});

JobDescription.hasMany(Candidate);
Candidate.belongsTo(JobDescription);
Candidate.hasMany(Interview);
Interview.belongsTo(Candidate);
Panelist.hasMany(Interview);
Interview.belongsTo(Panelist);
Candidate.hasOne(Offer);
Offer.belongsTo(Candidate);
Candidate.hasOne(Employee);
Employee.belongsTo(Candidate);
Employee.hasMany(OnboardingTask);
OnboardingTask.belongsTo(Employee);
Employee.hasMany(BgvCheck);
BgvCheck.belongsTo(Employee);
Employee.hasMany(PayrollRun);
PayrollRun.belongsTo(Employee);
Employee.hasMany(LeaveRequest);
LeaveRequest.belongsTo(Employee);
Employee.hasMany(ExpenseClaim);
ExpenseClaim.belongsTo(Employee);
Employee.hasMany(RelievingCase);
RelievingCase.belongsTo(Employee);
Employee.hasMany(AttendanceRecord);
AttendanceRecord.belongsTo(Employee);
Employee.hasMany(PerformanceReview);
PerformanceReview.belongsTo(Employee);
Employee.hasMany(GeneratedLetter);
GeneratedLetter.belongsTo(Employee);
Employee.hasMany(FinalSettlement);
FinalSettlement.belongsTo(Employee);
Employee.hasMany(Notification);
Notification.belongsTo(Employee);
Employee.hasOne(User);
User.belongsTo(Employee);

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function scoreCandidate(candidate, jd) {
  const required = new Set((jd.requiredSkills || []).map((skill) => skill.toLowerCase()));
  const matched = (candidate.skills || []).filter((skill) => required.has(skill.toLowerCase())).length;
  const skillScore = required.size ? Math.round((matched / required.size) * 70) : 30;
  const expScore = Number(candidate.experienceYears || 0) >= Number(jd.minExperience || 0) ? 20 : 8;
  return Math.min(100, skillScore + expScore + 10);
}

async function queueMail({ to, subject, html, kind }) {
  return MailLog.create({ to: Array.isArray(to) ? to.join(', ') : to, subject, html, kind, status: 'Queued' });
}

function generateFirstTimePassword({ name, employeeCode }) {
  const cleanName = String(name || 'User').replace(/[^a-zA-Z]/g, '').slice(0, 4) || 'User';
  const code = String(employeeCode || Date.now()).replace(/\D/g, '').slice(-4) || '2026';
  return `${cleanName}@${code}`;
}

async function provisionPortalUser({ employee, role = 'Employee', portalAccess = 'user' }) {
  const existing = await User.findOne({ where: { email: employee.email } });
  if (existing) return { user: existing, password: null, created: false };
  const password = generateFirstTimePassword({ name: employee.name, employeeCode: employee.employeeCode });
  const user = await User.create({
    EmployeeId: employee.id,
    name: employee.name,
    email: employee.email,
    passwordHash: await bcrypt.hash(password, 10),
    role,
    portalAccess,
    mustChangePassword: true
  });
  await queueMail({
    to: employee.email,
    kind: 'Portal Access Outbound',
    subject: 'Your HRMS portal login credentials',
    html: `<p>Dear ${employee.name},</p><p>Your HRMS portal access is now active.</p><p>Username: <strong>${employee.email}</strong><br/>First-time password: <strong>${password}</strong></p><p>Please change your password after first login. Password rule: first 4 letters of name + @ + last 4 digits of employee code.</p>`
  });
  return { user, password, created: true };
}

async function ensureRecruitmentDemoData() {
  const jdDefinitions = [
    ['Senior React Engineer', 'Product Engineering', 'Hyderabad / Remote', 4, 3, ['React', 'Node.js', 'PostgreSQL', 'REST', 'Testing']],
    ['Node.js API Developer', 'Platform Engineering', 'Hyderabad', 3, 2, ['Node.js', 'Express', 'PostgreSQL', 'Sequelize', 'JWT']],
    ['QA Automation Engineer', 'Quality Engineering', 'Visakhapatnam / Hybrid', 3, 2, ['Playwright', 'API Testing', 'JavaScript', 'Regression', 'CI/CD']],
    ['DevOps Engineer', 'Cloud Operations', 'Hyderabad', 4, 1, ['AWS', 'Docker', 'Kubernetes', 'CI/CD', 'Monitoring']],
    ['UI/UX Product Designer', 'Design', 'Hyderabad / Remote', 3, 1, ['Figma', 'Design Systems', 'User Research', 'Prototyping', 'SaaS']]
  ];
  const jobsByTitle = {};
  for (const [title, department, location, minExperience, openings, requiredSkills] of jdDefinitions) {
    const [job] = await JobDescription.findOrCreate({
      where: { title },
      defaults: {
        title,
        department,
        location,
        employmentType: 'Full-time',
        minExperience,
        openings,
        salaryMin: 800000 + minExperience * 100000,
        salaryMax: 1400000 + minExperience * 200000,
        requiredSkills,
        responsibilities: `Own ${title} responsibilities for the product engineering organization.`,
        qualification: 'B.Tech / MCA or equivalent professional experience.',
        reportingManager: department === 'Design' ? 'Product Head' : 'Engineering Manager',
        approvalStatus: 'Approved',
        status: 'Open',
        description: `${title} role for HRMS product delivery.`
      }
    });
    await job.update({ department, location, minExperience, openings, requiredSkills, approvalStatus: 'Approved', status: 'Open' });
    jobsByTitle[title] = job;
  }

  const roleCandidates = {
    'Senior React Engineer': [
      'Sai Kiran Reddy', 'Sravani Goud', 'Anusha Reddy', 'Karthik Naidu', 'Bhargavi Chowdary',
      'Rohit Varma', 'Mounika Yadav', 'Charan Teja', 'Divya Sree', 'Naveen Kumar'
    ],
    'Node.js API Developer': [
      'Venkata Teja Chowdary', 'Madhav Reddy', 'Keerthi Priya', 'Sandeep Goud', 'Lakshmi Narayana',
      'Pavan Kumar', 'Tejaswini Rao', 'Abhinav Varma', 'Sushma Rani', 'Raghavendra Naidu'
    ],
    'QA Automation Engineer': [
      'Harika Reddy', 'Akash Goud', 'Sindhuja Naidu', 'Nikhil Reddy', 'Poojitha Yadav',
      'Manideep Varma', 'Yamini Chowdary', 'Rakesh Kumar', 'Sirisha Devi', 'Vijay Teja'
    ],
    'DevOps Engineer': [
      'Praneeth Varma', 'Kavya Reddy', 'Arjun Naidu', 'Swathi Goud', 'Dinesh Kumar',
      'Meghana Chowdary', 'Vamsi Krishna', 'Priyanka Reddy', 'Lokesh Yadav', 'Sowmya Rao'
    ],
    'UI/UX Product Designer': [
      'Lahari Naidu', 'Akhila Reddy', 'Rahul Goud', 'Sahithi Varma', 'Nandini Chowdary',
      'Kiran Teja', 'Deepthi Yadav', 'Srinivas Rao', 'Ritika Reddy', 'Mahesh Naidu'
    ]
  };
  const roleSkills = {
    'Senior React Engineer': [
      ['React', 'Node.js', 'PostgreSQL', 'REST'],
      ['React', 'TypeScript', 'Testing', 'Redux'],
      ['React', 'JavaScript', 'API Testing', 'CI/CD']
    ],
    'Node.js API Developer': [
      ['Node.js', 'Express', 'PostgreSQL', 'Sequelize'],
      ['Node.js', 'JWT', 'REST', 'API Testing'],
      ['Express', 'PostgreSQL', 'Docker', 'CI/CD']
    ],
    'QA Automation Engineer': [
      ['Playwright', 'API Testing', 'JavaScript', 'CI/CD'],
      ['Playwright', 'Regression', 'JavaScript', 'Testing'],
      ['API Testing', 'Postman', 'JavaScript', 'CI/CD']
    ],
    'DevOps Engineer': [
      ['AWS', 'Docker', 'Kubernetes', 'CI/CD'],
      ['AWS', 'Monitoring', 'Linux', 'Terraform'],
      ['Docker', 'Kubernetes', 'CI/CD', 'PostgreSQL']
    ],
    'UI/UX Product Designer': [
      ['Figma', 'Design Systems', 'User Research', 'SaaS'],
      ['Figma', 'Prototyping', 'User Research', 'Wireframing'],
      ['Design Systems', 'SaaS', 'Product Thinking', 'Figma']
    ]
  };
  const legacyEmails = {
    'Sai Kiran Reddy': 'aarav.mehta@example.com',
    'Sravani Goud': 'nisha.rao@example.com',
    'Venkata Teja Chowdary': 'kabir.sethi@example.com'
  };
  const statuses = ['New', 'Screened', 'Shortlisted', 'Shortlisted', 'Interview Scheduled'];
  const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/(^\.|\.$)/g, '');
  const candidates = Object.entries(roleCandidates).flatMap(([roleApplied, names]) => names.map((name, index) => [
    legacyEmails[name] || null,
    name,
    `${slug(name)}@example.com`,
    roleApplied,
    Number((Number(jobsByTitle[roleApplied].minExperience || 2) + 0.4 + (index % 5) * 0.55).toFixed(1)),
    roleSkills[roleApplied][index % roleSkills[roleApplied].length],
    statuses[index % statuses.length],
    72 + ((index * 4) % 24)
  ]));

  for (const [oldEmail, name, email, roleApplied, experienceYears, skills, status, shortlistScore] of candidates) {
    const existing = await Candidate.findOne({
      where: oldEmail ? { [Op.or]: [{ email: oldEmail }, { email }] } : { email }
    });
    const payload = {
      name,
      email,
      phone: '+91 98765 12345',
      currentCompany: `${roleApplied.split(' ')[0]} Labs Hyderabad`,
      currentCtc: 900000 + Math.round(experienceYears * 100000),
      expectedCtc: 1200000 + Math.round(experienceYears * 140000),
      noticePeriod: experienceYears >= 5 ? '45 days' : '30 days',
      linkedin: `https://linkedin.com/in/${name.toLowerCase().replaceAll(' ', '')}`,
      github: `https://github.com/${name.toLowerCase().replaceAll(' ', '')}`,
      roleApplied,
      experienceYears,
      skills,
      cvUrl: `https://example.com/cv/${name.toLowerCase().replaceAll(' ', '-')}.pdf`,
      source: 'LinkedIn',
      status,
      shortlistScore,
      JobDescriptionId: jobsByTitle[roleApplied].id
    };
    if (existing) await existing.update(payload);
    else await Candidate.create(payload);
  }

  const legacyMailReplacements = [
    ['Kabir Sethi', 'Venkata Teja Chowdary'],
    ['kabir.sethi@example.com', 'venkata.teja.chowdary@example.com'],
    ['Aarav Mehta', 'Sai Kiran Reddy'],
    ['aarav.mehta@example.com', 'sai.kiran.reddy@example.com'],
    ['Nisha Rao', 'Sravani Goud'],
    ['nisha.rao@example.com', 'sravani.goud@example.com']
  ];
  const legacyMails = await MailLog.findAll({
    where: {
      [Op.or]: legacyMailReplacements.flatMap(([oldValue]) => [
        { to: { [Op.iLike]: `%${oldValue}%` } },
        { subject: { [Op.iLike]: `%${oldValue}%` } },
        { html: { [Op.iLike]: `%${oldValue}%` } }
      ])
    }
  });
  for (const mail of legacyMails) {
    const next = { to: mail.to || '', subject: mail.subject || '', html: mail.html || '' };
    for (const [oldValue, newValue] of legacyMailReplacements) {
      next.to = next.to.replaceAll(oldValue, newValue);
      next.subject = next.subject.replaceAll(oldValue, newValue);
      next.html = next.html.replaceAll(oldValue, newValue);
    }
    await mail.update(next);
  }
}

async function ensureDemoDocumentUrls() {
  const tasks = await OnboardingTask.findAll({
    include: [Employee],
    where: { [Op.or]: [{ documentUrl: null }, { documentUrl: 'Approved by HR' }] }
  });
  for (const task of tasks) {
    const code = task.Employee?.employeeCode || `EMP${task.EmployeeId || task.id}`;
    await task.update({
      documentUrl: `/demo-documents/${code}-${task.title.toLowerCase().replaceAll(' ', '-')}.pdf`
    });
  }
}

function offerHtml({ candidate, offer }) {
  return `
    <article style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#172033;max-width:760px;margin:auto">
      <h1 style="color:#0f766e">Offer of Employment</h1>
      <p>Dear ${candidate.name},</p>
      <p>We are pleased to offer you the position of <strong>${offer.designation}</strong>. Your annual CTC will be <strong>INR ${Number(offer.annualCtc).toLocaleString('en-IN')}</strong>, and your expected joining date is <strong>${offer.joiningDate}</strong>.</p>
      <p>This offer is subject to successful document submission, background verification, and acceptance of company policies.</p>
      <p>Welcome aboard. We look forward to building excellent software with you.</p>
      <p style="margin-top:32px">Regards,<br/>Human Resources</p>
    </article>`;
}

function hasMicrosoftGraphConfig() {
  return Boolean(process.env.MS_GRAPH_TENANT_ID && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET && process.env.MS_GRAPH_USER_ID);
}

function teamsIntegrationStatus() {
  return {
    provider: 'Microsoft Teams',
    organizer: process.env.MS_GRAPH_USER_ID || '',
    displayName: process.env.MS_GRAPH_ORGANIZER_DISPLAY_NAME || '',
    mode: hasMicrosoftGraphConfig() ? 'Live Microsoft Graph' : 'Demo link fallback',
    configured: hasMicrosoftGraphConfig(),
    missing: ['MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET', 'MS_GRAPH_USER_ID'].filter((key) => !process.env[key])
  };
}

function hasGoogleCalendarConfig() {
  return Boolean(process.env.GOOGLE_CALENDAR_ID && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

async function getMicrosoftGraphToken() {
  const tokenUrl = `https://login.microsoftonline.com/${process.env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: process.env.MS_GRAPH_CLIENT_ID,
    client_secret: process.env.MS_GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) throw new Error(`Microsoft Graph token failed: ${response.status} ${await response.text()}`);
  const token = await response.json();
  return token.access_token;
}

async function createTeamsMeeting({ candidate, stage, scheduledAt }) {
  if (hasMicrosoftGraphConfig()) {
    const start = new Date(scheduledAt);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const accessToken = await getMicrosoftGraphToken();
    const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.MS_GRAPH_USER_ID)}/onlineMeetings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        subject: `${stage} - ${candidate.name}`
      })
    });
    if (!response.ok) throw new Error(`Microsoft Teams meeting failed: ${response.status} ${await response.text()}`);
    const meeting = await response.json();
    return {
      id: meeting.id,
      joinUrl: meeting.joinWebUrl,
      subject: meeting.subject,
      provider: 'Microsoft Graph'
    };
  }
  const token = `${candidate.id}-${Date.now()}`;
  return {
    id: `teams-${token}`,
    joinUrl: `https://teams.microsoft.com/l/meetup-join/demo-${token}`,
    subject: `${stage} - ${candidate.name}`,
    provider: 'Demo'
  };
}

async function createGoogleCalendarEvent({ candidate, panelist, interview }) {
  const start = new Date(interview.scheduledAt);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  if (!hasGoogleCalendarConfig()) {
    return {
      id: `demo-calendar-${interview.id}`,
      htmlLink: 'Google Calendar credentials not configured',
      status: 'Demo Calendar Reminder Created'
    };
  }
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  const calendar = google.calendar({ version: 'v3', auth });
  const response = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    requestBody: {
      summary: `Interview - ${candidate.name}`,
      description: `Panelist: ${panelist.name}\nRound: ${interview.stage}\nMicrosoft Teams: ${interview.meetingLink}`,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: [
        { email: candidate.email },
        { email: panelist.email }
      ],
      reminders: { useDefault: true }
    },
    sendUpdates: 'all'
  });
  return {
    id: response.data.id,
    htmlLink: response.data.htmlLink,
    status: 'Google Calendar Reminder Created'
  };
}

function calendarSummary({ candidate, panelist, scheduledAt, meetingLink }) {
  const when = new Date(scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  return {
    provider: 'Google Calendar',
    status: 'Will be created after candidate accepts',
    title: `Interview - ${candidate.name}`,
    description: `Panelist: ${panelist.name}. Join: ${meetingLink}`,
    when
  };
}

async function ensureDemoEmployee() {
  const demoEmployee = {
    employeeCode: 'EMP1001',
    name: 'Sai Kiran Reddy',
    email: 'sai.kiran.reddy@company.local',
    department: 'Product Engineering',
    designation: 'Senior React Engineer',
    joiningDate: '2024-07-15',
    manager: 'Priya Menon',
    salaryAnnual: 1800000,
    status: 'Active',
    leaveBalance: 18
  };
  const existing = await Employee.findOne({ where: { employeeCode: 'EMP1001' } });
  if (existing) {
    await existing.update(demoEmployee);
    const firstTimePassword = generateFirstTimePassword(demoEmployee);
    const targetUser = await User.findOne({ where: { email: demoEmployee.email } });
    const oldUser = await User.findOne({ where: { email: 'meera.krishnan@company.local' } });
    const userToUpdate = targetUser || oldUser;
    if (userToUpdate) {
      await userToUpdate.update({
        EmployeeId: existing.id,
        name: demoEmployee.name,
        email: demoEmployee.email,
        passwordHash: await bcrypt.hash(firstTimePassword, 10),
        portalAccess: 'user',
        role: 'Employee',
        mustChangePassword: true
      });
    }
    await provisionPortalUser({ employee: existing });
    return existing;
  }
  const employee = await Employee.create({
    ...demoEmployee
  });
  await OnboardingTask.bulkCreate(['Aadhaar', 'PAN', 'Bank details', 'Education certificates', 'Previous relieving letter', 'Signed offer letter'].map((title, index) => ({
    title,
    category: 'Document',
    status: index < 4 ? 'Verified' : 'Pending',
    EmployeeId: employee.id,
    dueDate: '2024-07-10',
    documentUrl: `/demo-documents/${employee.employeeCode}-${title.toLowerCase().replaceAll(' ', '-')}.pdf`
  })));
  await BgvCheck.bulkCreate(['Identity verification', 'Address verification', 'Education verification', 'Employment verification', 'Reference check'].map((type, index) => ({
    type,
    vendor: 'Preferred BGV Partner',
    status: index < 3 ? 'Clear' : 'In Progress',
    EmployeeId: employee.id
  })));
  await LeaveRequest.create({ EmployeeId: employee.id, type: 'Earned Leave', startDate: '2026-05-12', endDate: '2026-05-13', days: 2, reason: 'Family travel', status: 'Pending' });
  await ExpenseClaim.create({ EmployeeId: employee.id, category: 'Internet', amount: 2500, spentOn: '2026-05-01', description: 'Monthly remote work reimbursement', status: 'Manager Approved' });
  await PayrollRun.create({ EmployeeId: employee.id, month: '2026-05', grossPay: 150000, deductions: 22000, reimbursements: 2500, netPay: 130500, status: 'Reviewed' });
  await AttendanceRecord.bulkCreate([
    { EmployeeId: employee.id, date: '2026-05-01', checkIn: '09:42', checkOut: '18:35', status: 'Present', workMode: 'Office' },
    { EmployeeId: employee.id, date: '2026-05-02', checkIn: '10:05', checkOut: '18:20', status: 'Late', workMode: 'Office' },
    { EmployeeId: employee.id, date: '2026-05-03', checkIn: '09:30', checkOut: '18:40', status: 'Work From Home', workMode: 'Remote' }
  ]);
  await PerformanceReview.create({ EmployeeId: employee.id, cycle: 'Q1 2026', selfRating: 4.2, managerRating: 4.4, finalRating: 4.3, status: 'HR Review', recommendation: 'Promotion track' });
  await GeneratedLetter.bulkCreate([
    { EmployeeId: employee.id, type: 'Appointment Letter', status: 'Generated', html: '<h1>Appointment Letter</h1><p>Welcome to the company.</p>' },
    { EmployeeId: employee.id, type: 'Salary Revision Letter', status: 'Draft', html: '<h1>Salary Revision</h1><p>Revision details pending approval.</p>' }
  ]);
  await FinalSettlement.create({ EmployeeId: employee.id, pendingSalary: 0, leaveEncashment: 45000, reimbursements: 2500, deductions: 0, netPayable: 47500, status: 'Pending' });
  await Notification.bulkCreate([
    { EmployeeId: employee.id, title: 'Leave approval pending', body: 'Manager approval is pending for earned leave.', channel: 'In-app' },
    { EmployeeId: employee.id, title: 'Payroll reviewed', body: 'May 2026 payroll is ready for approval.', channel: 'Email' }
  ]);
  await provisionPortalUser({ employee });
  return employee;
}

async function seed() {
  const admin = await User.findOne({ where: { email: 'admin@company.local' } });
  if (!admin) {
    await User.create({
      name: 'HR Admin',
      email: 'admin@company.local',
      passwordHash: await bcrypt.hash('Admin@2026', 10),
      role: 'HR Admin',
      portalAccess: 'admin',
      mustChangePassword: false
    });
  }
  const count = await JobDescription.count();
  if (count) {
    await ensureRecruitmentDemoData();
    await ensureDemoEmployee();
    await ensureDemoDocumentUrls();
    return;
  }
  const jd = await JobDescription.create({
    title: 'Senior React Engineer',
    department: 'Product Engineering',
    location: 'Hyderabad / Remote',
    employmentType: 'Full-time',
    minExperience: 4,
    openings: 3,
    salaryMin: 1200000,
    salaryMax: 2200000,
    requiredSkills: ['React', 'Node.js', 'PostgreSQL', 'REST', 'Testing'],
    responsibilities: 'Build product workflows, own frontend architecture, collaborate with backend teams, mentor engineers, and improve quality gates.',
    qualification: 'B.Tech / MCA or equivalent software engineering experience.',
    reportingManager: 'Engineering Manager',
    description: 'Own modern product experiences, collaborate with platform teams, and ship reliable software.'
  });
  await Candidate.bulkCreate([
    { name: 'Aarav Mehta', email: 'aarav.mehta@example.com', phone: '+91 98765 11111', currentCompany: 'CloudNova', currentCtc: 1450000, expectedCtc: 1900000, noticePeriod: '30 days', linkedin: 'https://linkedin.com/in/aarav', github: 'https://github.com/aarav', roleApplied: jd.title, experienceYears: 5, skills: ['React', 'Node.js', 'PostgreSQL', 'AWS'], cvUrl: 'https://example.com/cv/aarav.pdf', source: 'LinkedIn', status: 'Shortlisted', shortlistScore: 88, JobDescriptionId: jd.id },
    { name: 'Nisha Rao', email: 'nisha.rao@example.com', phone: '+91 98765 22222', currentCompany: 'FinStack Labs', currentCtc: 1250000, expectedCtc: 1700000, noticePeriod: '45 days', linkedin: 'https://linkedin.com/in/nisha', github: 'https://github.com/nisha', roleApplied: jd.title, experienceYears: 4.5, skills: ['React', 'REST', 'Testing', 'TypeScript'], cvUrl: 'https://example.com/cv/nisha.pdf', source: 'Referral', status: 'Interview Scheduled', shortlistScore: 82, JobDescriptionId: jd.id },
    { name: 'Kabir Sethi', email: 'kabir.sethi@example.com', phone: '+91 98765 33333', currentCompany: 'ByteCraft', currentCtc: 900000, expectedCtc: 1300000, noticePeriod: '60 days', linkedin: 'https://linkedin.com/in/kabir', github: 'https://github.com/kabir', roleApplied: jd.title, experienceYears: 3, skills: ['Vue', 'Node.js', 'PostgreSQL'], cvUrl: 'https://example.com/cv/kabir.pdf', source: 'Naukri', status: 'Screening Hold', shortlistScore: 54, JobDescriptionId: jd.id }
  ]);
  await Panelist.bulkCreate([
    { name: 'Priya Menon', email: 'priya.menon@company.local', expertise: 'Frontend Architecture', availability: 'Weekdays 2 PM - 5 PM' },
    { name: 'Rohan Iyer', email: 'rohan.iyer@company.local', expertise: 'Backend and Data', availability: 'Weekdays 11 AM - 1 PM' },
    { name: 'Sara Thomas', email: 'sara.thomas@company.local', expertise: 'Culture and Delivery', availability: 'Fridays' }
  ]);
  const candidate = await Candidate.findOne({ where: { email: 'nisha.rao@example.com' } });
  const panelist = await Panelist.findOne({ where: { email: 'priya.menon@company.local' } });
  await Interview.create({
    CandidateId: candidate.id,
    PanelistId: panelist.id,
    stage: 'Technical Round 1',
    scheduledAt: new Date(Date.now() + 86400000),
    mode: 'Video',
    meetingLink: 'https://meet.example.com/hrms-demo',
    status: 'Scheduled',
    decision: 'Pending'
  });
  const employee = await Employee.create({
    employeeCode: 'EMP1001',
    name: 'Sai Kiran Reddy',
    email: 'sai.kiran.reddy@company.local',
    department: 'Product Engineering',
    designation: 'Senior React Engineer',
    joiningDate: '2024-07-15',
    manager: 'Priya Menon',
    salaryAnnual: 1800000,
    status: 'Active',
    leaveBalance: 18
  });
  await OnboardingTask.bulkCreate(['Aadhaar', 'PAN', 'Bank details', 'Education certificates', 'Previous relieving letter', 'Signed offer letter'].map((title, index) => ({
    title,
    category: 'Document',
    status: index < 4 ? 'Verified' : 'Pending',
    EmployeeId: employee.id,
    dueDate: '2024-07-10',
    documentUrl: `/demo-documents/${employee.employeeCode}-${title.toLowerCase().replaceAll(' ', '-')}.pdf`
  })));
  await BgvCheck.bulkCreate(['Identity verification', 'Address verification', 'Education verification', 'Employment verification', 'Reference check'].map((type, index) => ({
    type,
    vendor: 'Preferred BGV Partner',
    status: index < 3 ? 'Clear' : 'In Progress',
    EmployeeId: employee.id
  })));
  await LeaveRequest.create({ EmployeeId: employee.id, type: 'Earned Leave', startDate: '2026-05-12', endDate: '2026-05-13', days: 2, reason: 'Family travel', status: 'Pending' });
  await ExpenseClaim.create({ EmployeeId: employee.id, category: 'Internet', amount: 2500, spentOn: '2026-05-01', description: 'Monthly remote work reimbursement', status: 'Manager Approved' });
  await PayrollRun.create({ EmployeeId: employee.id, month: '2026-05', grossPay: 150000, deductions: 22000, reimbursements: 2500, netPay: 130500, status: 'Reviewed' });
  await AttendanceRecord.bulkCreate([
    { EmployeeId: employee.id, date: '2026-05-01', checkIn: '09:42', checkOut: '18:35', status: 'Present', workMode: 'Office' },
    { EmployeeId: employee.id, date: '2026-05-02', checkIn: '10:05', checkOut: '18:20', status: 'Late', workMode: 'Office' },
    { EmployeeId: employee.id, date: '2026-05-03', checkIn: '09:30', checkOut: '18:40', status: 'Work From Home', workMode: 'Remote' }
  ]);
  await PerformanceReview.create({ EmployeeId: employee.id, cycle: 'Q1 2026', selfRating: 4.2, managerRating: 4.4, finalRating: 4.3, status: 'HR Review', recommendation: 'Promotion track' });
  await GeneratedLetter.bulkCreate([
    { EmployeeId: employee.id, type: 'Appointment Letter', status: 'Generated', html: '<h1>Appointment Letter</h1><p>Welcome to the company.</p>' },
    { EmployeeId: employee.id, type: 'Salary Revision Letter', status: 'Draft', html: '<h1>Salary Revision</h1><p>Revision details pending approval.</p>' }
  ]);
  await Notification.bulkCreate([
    { EmployeeId: employee.id, title: 'Leave approval pending', body: 'Manager approval is pending for earned leave.', channel: 'In-app' },
    { EmployeeId: employee.id, title: 'Payroll reviewed', body: 'May 2026 payroll is ready for approval.', channel: 'Email' }
  ]);
  await FinalSettlement.create({ EmployeeId: employee.id, pendingSalary: 0, leaveEncashment: 45000, reimbursements: 2500, deductions: 0, netPayable: 47500, status: 'Pending' });
  await provisionPortalUser({ employee });
  await ensureRecruitmentDemoData();
  await ensureDemoDocumentUrls();
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await sequelize.authenticate();
  res.json({ ok: true, database: process.env.DB_NAME });
}));

app.get('/api/bootstrap', asyncRoute(async (_req, res) => {
  const [jds, candidates, panelists, interviews, offers, employees, mails] = await Promise.all([
    JobDescription.findAll({ order: [['createdAt', 'DESC']] }),
    Candidate.findAll({ include: [JobDescription, Offer], order: [['updatedAt', 'DESC']] }),
    Panelist.findAll({ order: [['name', 'ASC']] }),
    Interview.findAll({ include: [Candidate, Panelist], order: [['scheduledAt', 'DESC']] }),
    Offer.findAll({ include: [Candidate], order: [['updatedAt', 'DESC']] }),
    Employee.findAll({ include: [OnboardingTask, BgvCheck, PayrollRun, LeaveRequest, ExpenseClaim, RelievingCase, AttendanceRecord, PerformanceReview, GeneratedLetter, FinalSettlement, Notification], order: [['createdAt', 'DESC']] }),
    MailLog.findAll({ order: [['createdAt', 'DESC']], limit: 20 })
  ]);
  res.json({ jds, candidates, panelists, interviews, offers, employees, mails, integrations: { teams: teamsIntegrationStatus() } });
}));

app.get('/api/integrations/teams/status', asyncRoute(async (_req, res) => {
  res.json(teamsIntegrationStatus());
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password, portal } = req.body;
  const user = await User.findOne({ where: { email } });
  if (!user || user.status !== 'Active') return res.status(401).json({ message: 'Invalid username or password.' });
  if (portal && user.portalAccess !== portal && user.portalAccess !== 'both') return res.status(403).json({ message: 'You do not have access to this portal.' });
  const valid = await bcrypt.compare(password || '', user.passwordHash);
  if (!valid) return res.status(401).json({ message: 'Invalid username or password.' });
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      portalAccess: user.portalAccess,
      mustChangePassword: user.mustChangePassword
    }
  });
}));

app.post('/api/auth/change-password', asyncRoute(async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  const user = await User.findOne({ where: { email } });
  if (!user) return res.status(404).json({ message: 'User not found.' });
  const valid = await bcrypt.compare(currentPassword || '', user.passwordHash);
  if (!valid) return res.status(401).json({ message: 'Current password is incorrect.' });
  if (!/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(newPassword || '')) {
    return res.status(400).json({ message: 'New password must be 8+ chars with uppercase, number, and symbol.' });
  }
  await user.update({ passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false });
  res.json({ message: 'Password changed successfully.' });
}));

app.post('/api/jds', asyncRoute(async (req, res) => res.status(201).json(await JobDescription.create(req.body))));
app.post('/api/candidates', asyncRoute(async (req, res) => res.status(201).json(await Candidate.create(req.body))));
app.post('/api/panelists', asyncRoute(async (req, res) => res.status(201).json(await Panelist.create(req.body))));

app.post('/api/jds/:id/shortlist', asyncRoute(async (req, res) => {
  const jd = await JobDescription.findByPk(req.params.id);
  if (!jd) return res.status(404).json({ message: 'JD not found' });
  const candidates = await Candidate.findAll({ where: { JobDescriptionId: jd.id } });
  const threshold = Number(req.body.threshold || 65);
  const shortlisted = [];
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, jd);
    const status = score >= threshold ? 'Shortlisted' : 'Screening Hold';
    await candidate.update({ shortlistScore: score, status });
    if (status === 'Shortlisted') shortlisted.push(candidate);
  }
  res.json({ shortlisted, threshold });
}));

app.post('/api/interviews', asyncRoute(async (req, res) => {
  const candidate = await Candidate.findByPk(req.body.CandidateId);
  const teams = await createTeamsMeeting({ candidate, stage: req.body.stage || 'Technical Round', scheduledAt: req.body.scheduledAt });
  const interview = await Interview.create({ ...req.body, mode: 'Microsoft Teams', meetingLink: req.body.meetingLink || teams.joinUrl, teamsMeetingId: teams.id });
  const full = await Interview.findByPk(interview.id, { include: [Candidate, Panelist] });
  await Candidate.update({ status: 'Interview Scheduled' }, { where: { id: req.body.CandidateId } });
  const when = new Date(full.scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  await queueMail({
    to: full.Candidate.email,
    kind: 'Candidate Interview',
    subject: `Interview scheduled: ${full.stage}`,
    html: `<p>Dear ${full.Candidate.name}, your ${full.stage} interview is scheduled on <strong>${when}</strong>. Mode: ${full.mode}. Link: ${full.meetingLink || 'To be shared'}.</p>`
  });
  await queueMail({
    to: full.Panelist.email,
    kind: 'Panel Interview',
    subject: `Panel invite: ${full.Candidate.name}`,
    html: `<p>Dear ${full.Panelist.name}, please interview ${full.Candidate.name} for ${full.Candidate.roleApplied} on <strong>${when}</strong>. CV: ${full.Candidate.cvUrl || 'Not uploaded'}.</p>`
  });
  res.status(201).json(full);
}));

app.post('/api/recruitment/schedule', asyncRoute(async (req, res) => {
  const { candidateIds = [], panelistIds = [], scheduledAt, stage = 'Technical Round 1', jdId } = req.body;
  if (!candidateIds.length || !panelistIds.length || !scheduledAt) {
    return res.status(400).json({ message: 'Select candidates, panel members, and interview date/time before sending mail.' });
  }
  const panelists = await Panelist.findAll({ where: { id: panelistIds } });
  const jd = jdId ? await JobDescription.findByPk(jdId) : null;
  const interviews = [];
  for (const candidateId of candidateIds) {
    const candidate = await Candidate.findByPk(candidateId);
    if (!candidate) continue;
    await candidate.update({ status: 'Interview Scheduled' });
    for (const panelist of panelists) {
      const teams = await createTeamsMeeting({ candidate, stage, scheduledAt });
      const interview = await Interview.create({
        CandidateId: candidate.id,
        PanelistId: panelist.id,
        stage,
        scheduledAt,
        mode: 'Microsoft Teams',
        meetingLink: teams.joinUrl,
        teamsMeetingId: teams.id,
        calendarProvider: 'Google Calendar',
        calendarStatus: 'Pending Candidate Acceptance',
        candidateResponse: 'Awaiting Response',
        status: 'Scheduled'
      });
      const calendar = calendarSummary({ candidate, panelist, scheduledAt, meetingLink: teams.joinUrl });
      await queueMail({
        to: candidate.email,
        kind: 'Interview Invitation Outbound',
        subject: `Interview Invitation for ${jd?.title || candidate.roleApplied || 'the role'}`,
        html: `<p>Dear ${candidate.name},</p><p>Your ${stage} interview is scheduled for <strong>${calendar.when}</strong>.</p><p>Mode: Microsoft Teams<br/>Join link: <a href="${teams.joinUrl}">${teams.joinUrl}</a></p><p>After you accept, the system will create a Google Calendar reminder for you.</p><p>Please keep your resume and identity document ready.</p>`
      });
      await queueMail({
        to: panelist.email,
        kind: 'Panel Assignment Outbound',
        subject: `Interview Panel Assignment - ${candidate.name} - ${jd?.title || candidate.roleApplied || 'Role'}`,
        html: `<p>Dear ${panelist.name},</p><p>You are assigned to interview <strong>${candidate.name}</strong> on <strong>${calendar.when}</strong>.</p><p>Round: ${stage}<br/>Resume: ${candidate.cvUrl || 'Not uploaded'}<br/>Teams: <a href="${teams.joinUrl}">${teams.joinUrl}</a></p><p>Feedback form will be available in the panel dashboard.</p>`
      });
      interviews.push(interview);
    }
  }
  res.status(201).json({ interviews, message: 'Interview mails queued for candidates and panel members.' });
}));

app.post('/api/interviews/:id/accept', asyncRoute(async (req, res) => {
  const interview = await Interview.findByPk(req.params.id, { include: [Candidate, Panelist] });
  if (!interview) return res.status(404).json({ message: 'Interview not found' });
  const calendarEvent = await createGoogleCalendarEvent({ candidate: interview.Candidate, panelist: interview.Panelist, interview });
  await interview.update({ candidateResponse: 'Accepted', calendarStatus: calendarEvent.status });
  await queueMail({
    to: `${interview.Candidate.email}, ${interview.Panelist.email}`,
    kind: 'Interview Acceptance Inbound',
    subject: `Interview accepted - ${interview.Candidate.name}`,
    html: `<p>${interview.Candidate.name} accepted the interview.</p><p>Calendar status: ${calendarEvent.status}<br/>Calendar link: ${calendarEvent.htmlLink}<br/>Microsoft Teams: <a href="${interview.meetingLink}">${interview.meetingLink}</a>.</p>`
  });
  res.json(interview);
}));

app.patch('/api/interviews/:id', asyncRoute(async (req, res) => {
  const interview = await Interview.findByPk(req.params.id, { include: [Candidate] });
  if (!interview) return res.status(404).json({ message: 'Interview not found' });
  await interview.update(req.body);
  if (req.body.decision === 'Selected') await interview.Candidate.update({ status: 'Selected' });
  if (req.body.decision === 'Rejected') await interview.Candidate.update({ status: 'Rejected' });
  res.json(interview);
}));

app.post('/api/offers', asyncRoute(async (req, res) => {
  const candidate = await Candidate.findByPk(req.body.CandidateId);
  if (!candidate) return res.status(404).json({ message: 'Candidate not found' });
  const draft = Offer.build(req.body);
  draft.html = req.body.html || offerHtml({ candidate, offer: draft });
  const offer = await draft.save();
  await candidate.update({ status: 'Offer Generated' });
  await queueMail({ to: candidate.email, kind: 'Offer', subject: `Offer letter: ${offer.designation}`, html: offer.html });
  res.status(201).json(offer);
}));

app.post('/api/offers/:id/accept', asyncRoute(async (req, res) => {
  const offer = await Offer.findByPk(req.params.id, { include: [Candidate] });
  if (!offer) return res.status(404).json({ message: 'Offer not found' });
  await offer.update({ status: 'Accepted' });
  const employee = await Employee.create({
    employeeCode: `EMP${String(Date.now()).slice(-6)}`,
    name: offer.Candidate.name,
    email: offer.Candidate.email,
    designation: offer.designation,
    department: req.body.department || 'Product Engineering',
    joiningDate: offer.joiningDate,
    manager: req.body.manager || 'Hiring Manager',
    salaryAnnual: offer.annualCtc,
    CandidateId: offer.Candidate.id
  });
  const tasks = ['Identity proof', 'Address proof', 'Education certificates', 'Experience letters', 'Bank details', 'Tax declaration', 'Policy acknowledgement'];
  await OnboardingTask.bulkCreate(tasks.map((title) => ({
    title,
    category: 'Document',
    EmployeeId: employee.id,
    dueDate: offer.joiningDate,
    documentUrl: `/demo-documents/${employee.employeeCode}-${title.toLowerCase().replaceAll(' ', '-')}.pdf`
  })));
  await BgvCheck.bulkCreate(['Identity', 'Employment', 'Education', 'Criminal record', 'Reference'].map((type) => ({ type, vendor: 'Preferred BGV Partner', EmployeeId: employee.id })));
  await offer.Candidate.update({ status: 'Onboarding' });
  await provisionPortalUser({ employee });
  res.status(201).json(employee);
}));

app.patch('/api/onboarding/:id', asyncRoute(async (req, res) => {
  const task = await OnboardingTask.findByPk(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  res.json(await task.update(req.body));
}));

app.patch('/api/onboarding/:id/decline', asyncRoute(async (req, res) => {
  const task = await OnboardingTask.findByPk(req.params.id, { include: [Employee] });
  if (!task) return res.status(404).json({ message: 'Task not found' });
  await task.update({ status: 'Declined', documentUrl: req.body.reason || 'Declined by HR' });
  if (task.Employee?.email) {
    await queueMail({
      to: task.Employee.email,
      kind: 'Document Decline Outbound',
      subject: `Document declined: ${task.title}`,
      html: `<p>Dear ${task.Employee.name}, your document <strong>${task.title}</strong> was declined. Reason: ${req.body.reason || 'Please upload a clearer/correct document'}.</p>`
    });
  }
  res.json(task);
}));

app.post('/api/offers/:id/welcome', asyncRoute(async (req, res) => {
  const offer = await Offer.findByPk(req.params.id, { include: [Candidate] });
  if (!offer) return res.status(404).json({ message: 'Offer not found' });
  await queueMail({
    to: offer.Candidate.email,
    kind: 'Welcome Mail Outbound',
    subject: `Welcome aboard, ${offer.Candidate.name}`,
    html: `<p>Dear ${offer.Candidate.name},</p><p>Welcome aboard. We are delighted to have you join as <strong>${offer.designation}</strong>. Your onboarding checklist and document submission link are now active in the employee portal.</p>`
  });
  res.json({ message: 'Welcome mail queued.' });
}));

app.patch('/api/bgv/:id', asyncRoute(async (req, res) => {
  const check = await BgvCheck.findByPk(req.params.id);
  if (!check) return res.status(404).json({ message: 'BGV check not found' });
  res.json(await check.update({ ...req.body, completedAt: req.body.status === 'Clear' ? new Date() : req.body.completedAt }));
}));

app.post('/api/leaves', asyncRoute(async (req, res) => res.status(201).json(await LeaveRequest.create(req.body))));
app.patch('/api/leaves/:id', asyncRoute(async (req, res) => {
  const leave = await LeaveRequest.findByPk(req.params.id, { include: [Employee] });
  if (!leave) return res.status(404).json({ message: 'Leave not found' });
  await leave.update(req.body);
  if (req.body.status === 'Approved') await leave.Employee.decrement('leaveBalance', { by: leave.days });
  res.json(leave);
}));

app.post('/api/expenses', asyncRoute(async (req, res) => res.status(201).json(await ExpenseClaim.create(req.body))));
app.patch('/api/expenses/:id', asyncRoute(async (req, res) => {
  const expense = await ExpenseClaim.findByPk(req.params.id);
  if (!expense) return res.status(404).json({ message: 'Expense not found' });
  res.json(await expense.update(req.body));
}));

app.post('/api/payroll/run', asyncRoute(async (req, res) => {
  const employees = await Employee.findAll({ where: { status: 'Active', id: req.body.EmployeeId ? req.body.EmployeeId : { [Op.ne]: null } } });
  const runs = [];
  for (const employee of employees) {
    const grossPay = Math.round(Number(employee.salaryAnnual || 0) / 12);
    const approvedExpenses = await ExpenseClaim.sum('amount', { where: { EmployeeId: employee.id, status: 'Approved' } });
    const deductions = Math.round(grossPay * 0.12);
    const reimbursements = Number(approvedExpenses || 0);
    runs.push(await PayrollRun.create({ EmployeeId: employee.id, month: req.body.month, grossPay, deductions, reimbursements, netPay: grossPay - deductions + reimbursements, status: 'Processed' }));
  }
  res.status(201).json(runs);
}));

app.patch('/api/payroll/:id/credit', asyncRoute(async (req, res) => {
  const run = await PayrollRun.findByPk(req.params.id);
  if (!run) return res.status(404).json({ message: 'Payroll run not found' });
  res.json(await run.update({ status: 'Credited', creditedAt: new Date() }));
}));

app.post('/api/relieving', asyncRoute(async (req, res) => {
  const employee = await Employee.findByPk(req.body.EmployeeId);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  await employee.update({ status: 'Notice Period' });
  res.status(201).json(await RelievingCase.create(req.body));
}));

app.patch('/api/relieving/:id', asyncRoute(async (req, res) => {
  const relieving = await RelievingCase.findByPk(req.params.id, { include: [Employee] });
  if (!relieving) return res.status(404).json({ message: 'Relieving case not found' });
  await relieving.update(req.body);
  if (req.body.status === 'Relieved') await relieving.Employee.update({ status: 'Relieved' });
  res.json(relieving);
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: err.message || 'Server error' });
});

sequelize.sync({ alter: true }).then(seed).then(() => {
  const server = app.listen(port, () => console.log(`HRMS API running on http://localhost:${port}`));

  server.on('error', (error) => {
    console.error('Failed to start HRMS API:', error.message);
    process.exit(1);
  });
}).catch((error) => {
  console.error('Failed to initialize HRMS API:', error);
  process.exit(1);
});
