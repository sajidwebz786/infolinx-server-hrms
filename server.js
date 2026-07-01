import express from 'express';
import cors from 'cors';
import { Sequelize, DataTypes, Op } from 'sequelize';
import { google } from 'googleapis';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const app = express();


const serverDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(serverDir, '.env') });
const port = process.env.PORT || 5000;
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const adminPortalDistDir = [
  process.env.ADMIN_PORTAL_DIST,
  path.resolve(serverDir, 'public'),
  path.resolve(serverDir, '..', 'public'),
  path.resolve(serverDir, '..', 'admin-portal', 'dist-render'),
  path.resolve(serverDir, '..', 'admin-portal', 'dist')
].filter(Boolean).find((dir) => fs.existsSync(path.join(dir, 'index.html')));

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use('/uploads', express.static(uploadDir));

const allowedOrigins = [
  ...(process.env.CLIENT_URLS || process.env.CLIENT_URL || '').split(','),
  'https://hrms.infolinx.com',
  'https://www.hrms.infolinx.com',
  'http://localhost:5173',
  'http://localhost:5174'
]
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter((origin, index, origins) => origin && origins.indexOf(origin) === index);

console.log('[CORS] allowedOrigins =', allowedOrigins);
console.log('[CORS] CLIENT_URLS env =', process.env.CLIENT_URLS);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const cleanOrigin = origin ? origin.replace(/\/$/, '') : '';
  const isLocalDevOrigin = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(cleanOrigin);

  if (!origin || allowedOrigins.includes(cleanOrigin) || isLocalDevOrigin) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }

  console.warn('[CORS] blocked origin:', cleanOrigin);
  return res.status(403).json({ message: `CORS blocked for origin: ${cleanOrigin}` });
});

app.use(express.json({ limit: "10mb" }));

const dbSslEnabled = /^(true|1|require)$/i.test(process.env.DB_SSL || '');
const dbDialectOptions = dbSslEnabled ? { ssl: { require: true, rejectUnauthorized: false } } : {};
const sequelizeOptions = {
  dialect: process.env.DB_DIALECT || 'postgres',
  dialectOptions: dbDialectOptions,
  logging: false
};

if (/^dpg-.+-a$/i.test(process.env.DB_HOST || '') && !process.env.DATABASE_URL) {
  console.warn('DB_HOST looks like a Render internal hostname. Use Render External Database URL locally, or run this API inside Render.');
}

const sequelize = process.env.DATABASE_URL
  ? new Sequelize(process.env.DATABASE_URL, sequelizeOptions)
  : new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
      ...sequelizeOptions,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 5432
    });

const mailTransporter = process.env.MAIL_MODE === 'smtp' ? nodemailer.createTransport({
  host: process.env.MAIL_HOST || process.env.SMTP_HOST || 'smtp.office365.com',
  port: Number(process.env.MAIL_PORT || process.env.SMTP_PORT || 587),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.MAIL_USER || process.env.SMTP_USER,
    pass: process.env.MAIL_PASSWORD || process.env.SMTP_PASS
  },
  tls: { ciphers: 'TLSv1.2', minVersion: 'TLSv1.2' }
}) : null;

const companyBrand = {
  name: process.env.COMPANY_NAME || 'Infolinx',
  email: process.env.HR_ADMIN_EMAIL || process.env.MAIL_FROM || process.env.MS_GRAPH_MAIL_USER_ID || process.env.MS_GRAPH_USER_ID || process.env.MAIL_USER || process.env.SMTP_USER || 'hr@infolinx.com',
  website: process.env.COMPANY_WEBSITE || process.env.ADMIN_PORTAL_URL || process.env.CLIENT_URL || 'https://hrms.infolinx.com',
  address: process.env.COMPANY_ADDRESS || 'Human Resources, Infolinx',
  logoCid: 'infolinx-logo'
};

const inlineLogoPath = [
  process.env.COMPANY_LOGO_PATH,
  path.resolve(serverDir, '..', 'logo.png'),
  path.resolve(serverDir, 'public', 'logo.png'),
  path.resolve(serverDir, '..', 'admin-portal', 'public', 'logo.png')
].filter(Boolean).find((logoPath) => fs.existsSync(logoPath));

function normalizeMailBody(html = '') {
  const source = String(html || '').trim() || '<p>No message body.</p>';
  if (source.includes('data-infolinx-email="official"')) return source;
  const bodyMatch = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : source;
}

function brandedEmailHtml({ subject, html, kind, from }) {
  const body = normalizeMailBody(html);
  const safeSubject = escapeHtml(subject || 'Official communication');
  const safeKind = escapeHtml(kind || 'HR Communication');
  const safeFrom = escapeHtml(from || companyBrand.email);
  const logoSrc = inlineLogoPath ? `cid:${companyBrand.logoCid}` : `${String(companyBrand.website).replace(/\/$/, '')}/logo.png`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeSubject}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef4fb;font-family:Arial,Helvetica,sans-serif;color:#172033;">
    <div data-infolinx-email="official" style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Official ${companyBrand.name} communication</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4fb;margin:0;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;border-collapse:collapse;background:#ffffff;border:1px solid #dbe7f4;border-radius:18px;overflow:hidden;box-shadow:0 18px 45px rgba(8,47,73,.12);">
            <tr>
              <td style="background:#0b2f4f;padding:0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="padding:24px 28px;">
                      <img src="${logoSrc}" alt="${companyBrand.name}" width="150" style="display:block;max-width:150px;height:auto;border:0;outline:none;text-decoration:none;background:#ffffff;border-radius:12px;padding:8px;">
                    </td>
                    <td align="right" style="padding:24px 28px;color:#d9f7ff;font-size:13px;line-height:1.5;">
                      <strong style="display:block;color:#ffffff;font-size:15px;">${safeKind}</strong>
                      <span>Official Staff Communication</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="height:6px;background:#18b6c7;font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:30px 32px 12px;">
                <h1 style="margin:0;color:#0b2f4f;font-size:24px;line-height:1.25;font-weight:700;">${safeSubject}</h1>
                <p style="margin:8px 0 0;color:#66717f;font-size:13px;line-height:1.5;">Sent by ${safeFrom}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 30px;">
                <div style="font-size:15px;line-height:1.65;color:#243142;">${body}</div>
              </td>
            </tr>
            <tr>
              <td style="background:#f7fbff;border-top:1px solid #dbe7f4;padding:22px 32px;color:#66717f;font-size:12px;line-height:1.6;">
                <strong style="display:block;color:#0b2f4f;font-size:14px;margin-bottom:4px;">${companyBrand.name} HRMS</strong>
                <span>${escapeHtml(companyBrand.address)}</span><br>
                <a href="${escapeHtml(companyBrand.website)}" style="color:#1d4ed8;text-decoration:none;">${escapeHtml(companyBrand.website)}</a>
                <p style="margin:12px 0 0;">This is an official ${companyBrand.name} communication. Please do not share confidential HRMS links, credentials, or documents outside authorized channels.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function brandedMailAttachments(attachments = [], html = '') {
  if (!inlineLogoPath || !html.includes(`cid:${companyBrand.logoCid}`)) return attachments;
  return [
    ...attachments,
    {
      filename: path.basename(inlineLogoPath),
      content: fs.readFileSync(inlineLogoPath).toString('base64'),
      encoding: 'base64',
      contentType: 'image/png',
      cid: companyBrand.logoCid,
      contentId: companyBrand.logoCid,
      isInline: true
    }
  ];
}

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
  offerDate: DataTypes.DATEONLY,
  designation: DataTypes.STRING,
  department: DataTypes.STRING,
  annualCtc: DataTypes.FLOAT,
  joiningDate: DataTypes.DATEONLY,
  candidateAddress: DataTypes.TEXT,
  workLocation: DataTypes.STRING,
  bandLevel: DataTypes.STRING,
  compensationPeriod: { type: DataTypes.STRING, defaultValue: 'Per Annum' },
  probationPeriod: DataTypes.STRING,
  noticePeriod: DataTypes.STRING,
  acceptanceDueDate: DataTypes.DATEONLY,
  reportingManager: DataTypes.STRING,
  hrName: DataTypes.STRING,
  salaryBreakup: { type: DataTypes.JSONB, defaultValue: {} },
  status: { type: DataTypes.STRING, defaultValue: 'Draft' },
  signedCopyUrl: DataTypes.TEXT,
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

const Department = sequelize.define('Department', {
  name: { type: DataTypes.STRING, unique: true, allowNull: false },
  code: DataTypes.STRING,
  head: DataTypes.STRING,
  location: DataTypes.STRING,
  status: { type: DataTypes.STRING, defaultValue: 'Active' },
  description: DataTypes.TEXT
});

const MasterRecord = sequelize.define('MasterRecord', {
  module: { type: DataTypes.STRING, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  code: DataTypes.STRING,
  status: { type: DataTypes.STRING, defaultValue: 'Active' },
  owner: DataTypes.STRING,
  category: DataTypes.STRING,
  amount: DataTypes.FLOAT,
  effectiveDate: DataTypes.DATEONLY,
  dueDate: DataTypes.DATEONLY,
  metadata: { type: DataTypes.JSONB, defaultValue: {} },
  description: DataTypes.TEXT
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
  totalHours: { type: DataTypes.FLOAT, defaultValue: 0 },
  clockInLocation: DataTypes.STRING,
  clockOutLocation: DataTypes.STRING,
  remarks: DataTypes.TEXT,
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

const LearningCourse = sequelize.define('LearningCourse', {
  title: DataTypes.STRING,
  category: DataTypes.STRING,
  audience: DataTypes.STRING,
  videoUrl: DataTypes.TEXT,
  textContent: DataTypes.TEXT,
  materialHtml: DataTypes.TEXT,
  pdfFileName: DataTypes.STRING,
  durationMinutes: DataTypes.INTEGER,
  status: { type: DataTypes.STRING, defaultValue: 'Published' },
  questions: { type: DataTypes.JSONB, defaultValue: [] }
});

const LearningAttempt = sequelize.define('LearningAttempt', {
  score: DataTypes.FLOAT,
  answers: { type: DataTypes.JSONB, defaultValue: {} },
  status: { type: DataTypes.STRING, defaultValue: 'Submitted' },
  completedAt: DataTypes.DATE
});

const CandidateTest = sequelize.define('CandidateTest', {
  title: DataTypes.STRING,
  questions: { type: DataTypes.JSONB, defaultValue: [] },
  answers: { type: DataTypes.JSONB, defaultValue: {} },
  score: { type: DataTypes.FLOAT, defaultValue: 0 },
  skillBreakdown: { type: DataTypes.JSONB, defaultValue: {} },
  strengths: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
  weaknesses: { type: DataTypes.ARRAY(DataTypes.STRING), defaultValue: [] },
  recommendation: DataTypes.TEXT,
  status: { type: DataTypes.STRING, defaultValue: 'Generated' },
  durationMinutes: { type: DataTypes.INTEGER, defaultValue: 45 },
  sentAt: DataTypes.DATE,
  submittedAt: DataTypes.DATE
});

const CandidateOnboardingDocument = sequelize.define('CandidateOnboardingDocument', {
  title: DataTypes.STRING,
  category: { type: DataTypes.STRING, defaultValue: 'Document' },
  status: { type: DataTypes.STRING, defaultValue: 'Pending' },
  documentUrl: DataTypes.TEXT,
  filename: DataTypes.STRING,
  contentType: DataTypes.STRING,
  size: DataTypes.INTEGER,
  remarks: DataTypes.TEXT,
  dueDate: DataTypes.DATEONLY,
  submittedAt: DataTypes.DATE
});

const LearningPath = sequelize.define('LearningPath', {
  level: DataTypes.STRING,
  title: DataTypes.STRING,
  durationDays: DataTypes.INTEGER,
  extensionDays: DataTypes.INTEGER,
  curriculum: { type: DataTypes.JSONB, defaultValue: [] },
  roadmap: DataTypes.TEXT,
  status: { type: DataTypes.STRING, defaultValue: 'Assigned' },
  progress: { type: DataTypes.INTEGER, defaultValue: 0 },
  assessmentsPassed: { type: DataTypes.INTEGER, defaultValue: 0 },
  dueDate: DataTypes.DATEONLY
});

const ExtensionRequest = sequelize.define('ExtensionRequest', {
  requestType: DataTypes.STRING,
  reason: DataTypes.TEXT,
  requestedDays: DataTypes.INTEGER,
  status: { type: DataTypes.STRING, defaultValue: 'Pending' },
  adminRemarks: DataTypes.TEXT
});

const ProjectAssignment = sequelize.define('ProjectAssignment', {
  title: DataTypes.STRING,
  description: DataTypes.TEXT,
  deliverables: DataTypes.TEXT,
  evaluationCriteria: DataTypes.TEXT,
  durationDays: { type: DataTypes.INTEGER, defaultValue: 15 },
  status: { type: DataTypes.STRING, defaultValue: 'Assigned' },
  submissionUrl: DataTypes.TEXT,
  reviewNotes: DataTypes.TEXT
});

const SprintBoard = sequelize.define('SprintBoard', {
  name: DataTypes.STRING,
  sprintGoal: DataTypes.TEXT,
  status: { type: DataTypes.STRING, defaultValue: 'Active' },
  startDate: DataTypes.DATEONLY,
  endDate: DataTypes.DATEONLY
});

const WorkTask = sequelize.define('WorkTask', {
  title: DataTypes.STRING,
  description: DataTypes.TEXT,
  storyPoints: DataTypes.INTEGER,
  priority: { type: DataTypes.STRING, defaultValue: 'Medium' },
  status: { type: DataTypes.STRING, defaultValue: 'To Do' },
  dailyUpdate: DataTypes.TEXT,
  timesheetHours: { type: DataTypes.FLOAT, defaultValue: 0 }
});

const Certification = sequelize.define('Certification', {
  title: DataTypes.STRING,
  level: DataTypes.STRING,
  issuedAt: DataTypes.DATEONLY,
  status: { type: DataTypes.STRING, defaultValue: 'In Progress' }
});

const Notification = sequelize.define('Notification', {
  title: DataTypes.STRING,
  body: DataTypes.TEXT,
  channel: { type: DataTypes.STRING, defaultValue: 'In-app' },
  status: { type: DataTypes.STRING, defaultValue: 'Unread' }
});

const MailLog = sequelize.define('MailLog', {
  to: DataTypes.TEXT,
  from: DataTypes.TEXT,
  fromName: DataTypes.STRING,
  toName: DataTypes.STRING,
  subject: DataTypes.STRING,
  html: DataTypes.TEXT,
  status: { type: DataTypes.STRING, defaultValue: 'Queued' },
  kind: DataTypes.STRING,
  direction: { type: DataTypes.STRING, defaultValue: 'outbound' },
  sourceMessageId: DataTypes.STRING,
  attachments: { type: DataTypes.JSONB, defaultValue: [] },
  attempts: { type: DataTypes.INTEGER, defaultValue: 0 },
  lastError: DataTypes.TEXT
});

const AuditLog = sequelize.define('AuditLog', {
  actor: { type: DataTypes.STRING, defaultValue: 'HR Admin' },
  action: DataTypes.STRING,
  entityType: DataTypes.STRING,
  entityId: DataTypes.INTEGER,
  details: { type: DataTypes.JSONB, defaultValue: {} }
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
Candidate.hasMany(CandidateTest);
CandidateTest.belongsTo(Candidate);
Candidate.hasMany(CandidateOnboardingDocument);
CandidateOnboardingDocument.belongsTo(Candidate);
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
LearningCourse.hasMany(LearningAttempt);
LearningAttempt.belongsTo(LearningCourse);
Employee.hasMany(LearningAttempt);
LearningAttempt.belongsTo(Employee);
Employee.hasMany(LearningPath);
LearningPath.belongsTo(Employee);
Employee.hasMany(ExtensionRequest);
ExtensionRequest.belongsTo(Employee);
Employee.hasMany(ProjectAssignment);
ProjectAssignment.belongsTo(Employee);
Employee.hasMany(SprintBoard);
SprintBoard.belongsTo(Employee);
SprintBoard.hasMany(WorkTask);
WorkTask.belongsTo(SprintBoard);
Employee.hasMany(WorkTask);
WorkTask.belongsTo(Employee);
Employee.hasMany(Certification);
Certification.belongsTo(Employee);
Employee.hasMany(Notification);
Notification.belongsTo(Employee);
Employee.hasOne(User);
User.belongsTo(Employee);

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function unique(list) {
  return [...new Set((list || []).filter(Boolean))];
}

const tokenSecret = process.env.JWT_DEMO_SECRET || process.env.SESSION_SECRET || 'replace-this-before-production';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signPortalToken(user) {
  const payload = base64url(JSON.stringify({ id: user.id, email: user.email, portalAccess: user.portalAccess, exp: Date.now() + 12 * 60 * 60 * 1000 }));
  const signature = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function signCandidateOnboardingToken(candidate, ttlDays = 14) {
  const payload = base64url(JSON.stringify({
    type: 'candidate-onboarding',
    id: candidate.id,
    email: candidate.email,
    exp: Date.now() + ttlDays * 24 * 60 * 60 * 1000
  }));
  const signature = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyPortalToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!parsed.exp || parsed.exp < Date.now()) return null;
  return parsed;
}

function verifySignedToken(token, expectedType) {
  const claims = verifyPortalToken(token);
  if (!claims || claims.type !== expectedType) return null;
  return claims;
}

const candidateOnboardingChecklist = [
  'Aadhaar / Identity Proof',
  'PAN Card',
  'Passport Photograph',
  'Address Proof',
  'Education Certificates',
  'Previous Offer Letter',
  'Previous Relieving Letter',
  'Previous Payslips',
  'Bank Details / Cancelled Cheque',
  'Form 16, if applicable',
  'Emergency Contact Details',
  'Signed Offer Letter'
];

async function ensureCandidateOnboardingDocuments(candidate) {
  const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const records = [];
  for (const title of candidateOnboardingChecklist) {
    const [record] = await CandidateOnboardingDocument.findOrCreate({
      where: { CandidateId: candidate.id, title },
      defaults: { CandidateId: candidate.id, title, category: 'Document', dueDate, status: 'Pending' }
    });
    records.push(record);
  }
  return records;
}

function candidateOnboardingUrl(candidate) {
  const token = signCandidateOnboardingToken(candidate);
  return `${process.env.CANDIDATE_PORTAL_URL || process.env.ADMIN_PORTAL_URL || 'http://localhost:5173'}/candidate-onboarding/${token}`;
}

function scoreCandidate(candidate, jd) {
  const required = new Set((jd.requiredSkills || []).map((skill) => skill.toLowerCase()));
  const matched = (candidate.skills || []).filter((skill) => required.has(skill.toLowerCase())).length;
  const skillScore = required.size ? Math.round((matched / required.size) * 70) : 30;
  const expScore = Number(candidate.experienceYears || 0) >= Number(jd.minExperience || 0) ? 20 : 8;
  return Math.min(100, skillScore + expScore + 10);
}

async function queueMail({ to, subject, html, kind, from, attachments = [], direction = 'outbound' }) {
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const outgoingHtml = direction === 'outbound' ? brandedEmailHtml({ subject, html, kind, from }) : html;
  const outgoingAttachments = direction === 'outbound' ? brandedMailAttachments(attachments, outgoingHtml) : attachments;
  const attachmentMeta = outgoingAttachments.filter((attachment) => !attachment.isInline).map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size || String(attachment.content || '').length
  }));
  const canSend = Boolean(mailTransporter || process.env.MAIL_MODE === 'graph');
  const mail = await MailLog.create({ to: recipients, from, subject, html: outgoingHtml, kind, direction, attachments: attachmentMeta, status: canSend ? 'Sending' : 'Queued' });
  if (!canSend) return mail;
  try {
    if (process.env.MAIL_MODE === 'graph') {
      await sendGraphMail({ to: recipients, subject, html: outgoingHtml, from, attachments: outgoingAttachments });
    } else {
      await mailTransporter.sendMail({
        from: process.env.MAIL_FROM || process.env.MAIL_USER || process.env.SMTP_USER,
        replyTo: from || undefined,
        to: recipients,
        subject,
        html: outgoingHtml,
        attachments: outgoingAttachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          encoding: attachment.encoding,
          contentType: attachment.contentType,
          cid: attachment.cid
        }))
      });
    }
    await mail.update({ status: 'Sent', attempts: mail.attempts + 1, lastError: null });
  } catch (error) {
    await mail.update({ status: 'Failed', attempts: mail.attempts + 1, lastError: error.message });
  }
  return mail;
}

async function getGraphToken() {
  const required = ['MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Microsoft Graph mail is not configured. Missing: ${missing.join(', ')}`);
  const response = await fetch(`https://login.microsoftonline.com/${process.env.MS_GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_GRAPH_CLIENT_ID,
      client_secret: process.env.MS_GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Microsoft Graph token failed: ${data.error_description || data.error || response.statusText}`);
  return data.access_token;
}

function decodeJwtPayload(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

async function sendGraphMail({ to, subject, html, from, attachments = [] }) {
  const sender = process.env.MS_GRAPH_MAIL_USER_ID || process.env.MS_GRAPH_USER_ID || process.env.MAIL_FROM || process.env.MAIL_USER || process.env.SMTP_USER;
  if (!sender) throw new Error('Microsoft Graph sender is not configured. Set MS_GRAPH_MAIL_USER_ID or MS_GRAPH_USER_ID.');
  const token = await getGraphToken();
  const toRecipients = String(to).split(',').map((address) => address.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }));
  const graphAttachments = attachments.map((attachment) => ({
    '@odata.type': '#microsoft.graph.fileAttachment',
    name: attachment.filename,
    contentType: attachment.contentType || 'application/octet-stream',
    contentBytes: Buffer.isBuffer(attachment.content) ? attachment.content.toString('base64') : attachment.content,
    isInline: Boolean(attachment.isInline),
    contentId: attachment.contentId || attachment.cid || undefined
  }));
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients,
        replyTo: from ? [{ emailAddress: { address: String(from).match(/<([^>]+)>/)?.[1] || from } }] : undefined,
        attachments: graphAttachments.length ? graphAttachments : undefined
      },
      saveToSentItems: true
    })
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 403 && /ErrorAccessDenied/i.test(text)) {
      throw new Error('Microsoft Graph sendMail failed (403 ErrorAccessDenied). Grant the Azure app Microsoft Graph Application permission "Mail.Send", click Admin consent, and ensure any Exchange Application Access Policy allows the sender mailbox.');
    }
    throw new Error(`Microsoft Graph sendMail failed (${response.status}): ${text}`);
  }
}

function graphMailboxUser() {
  return process.env.MS_GRAPH_MAIL_USER_ID || process.env.MS_GRAPH_USER_ID || process.env.MAIL_FROM || process.env.MAIL_USER || process.env.SMTP_USER;
}

function graphAddressLabel(address) {
  if (!address) return '';
  if (address.name && address.address) return `${address.name} <${address.address}>`;
  return address.address || address.name || '';
}

async function fetchGraphAttachments({ token, sender, messageId }) {
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.value || []).filter((attachment) => !attachment.isInline).map((attachment) => ({
    id: attachment.id,
    filename: attachment.name || 'attachment',
    contentType: attachment.contentType || 'application/octet-stream',
    size: attachment.size || 0
  }));
}

async function syncGraphInbox({ limit = 25 } = {}) {
  const sender = graphMailboxUser();
  if (!sender) throw new Error('Microsoft Graph mailbox is not configured. Set MS_GRAPH_MAIL_USER_ID or MS_GRAPH_USER_ID.');
  const token = await getGraphToken();
  const top = Math.min(Math.max(Number(limit) || 25, 1), 50);
  const select = 'id,subject,from,toRecipients,receivedDateTime,body,hasAttachments,isRead';
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&$select=${select}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="html"' } });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 403 && /ErrorAccessDenied|Access is denied/i.test(text)) {
      throw new Error('Microsoft Graph inbox sync failed (403 ErrorAccessDenied). Add Microsoft Graph Application permission "Mail.Read", click Admin consent, and ensure any Exchange Application Access Policy allows the sender mailbox.');
    }
    throw new Error(`Microsoft Graph inbox sync failed (${response.status}): ${text}`);
  }
  const data = await response.json();
  let created = 0;
  let updated = 0;
  for (const message of data.value || []) {
    const sourceMessageId = message.id;
    if (!sourceMessageId) continue;
    const fromAddress = message.from?.emailAddress || {};
    const toRecipients = (message.toRecipients || []).map((recipient) => graphAddressLabel(recipient.emailAddress)).filter(Boolean);
    const attachments = message.hasAttachments ? await fetchGraphAttachments({ token, sender, messageId: sourceMessageId }) : [];
    const payload = {
      to: toRecipients.join(', ') || sender,
      from: fromAddress.address || '',
      fromName: fromAddress.name || '',
      toName: toRecipients.join(', '),
      subject: message.subject || '(No subject)',
      html: message.body?.content || '',
      kind: 'Inbound Mail',
      direction: 'inbound',
      sourceMessageId,
      attachments,
      status: message.isRead ? 'Received' : 'Unread',
      lastError: null,
      attempts: 0,
      createdAt: message.receivedDateTime ? new Date(message.receivedDateTime) : new Date(),
      updatedAt: new Date()
    };
    const existing = await MailLog.findOne({ where: { sourceMessageId } });
    if (existing) {
      await existing.update({ ...payload, createdAt: existing.createdAt });
      updated += 1;
    } else {
      await MailLog.create(payload);
      created += 1;
    }
  }
  return { created, updated, checked: (data.value || []).length };
}

async function queueMailOnce({ to, subject, html, kind, entityType, entityId, from, attachments = [] }) {
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const existing = await MailLog.findOne({
    where: { to: recipients, subject, kind },
    order: [['createdAt', 'DESC']]
  });
  if (existing) {
    await writeAudit({ action: 'Skipped duplicate email', entityType: entityType || 'MailLog', entityId, details: { kind, to: recipients, subject, existingMailId: existing.id } });
    return existing;
  }
  const mail = await queueMail({ to: recipients, subject, html, kind, from, attachments });
  await writeAudit({ action: 'Queued email', entityType: entityType || 'MailLog', entityId: entityId || mail.id, details: { kind, to: recipients, subject, mailId: mail.id, status: mail.status } });
  return mail;
}

async function writeAudit({ action, entityType, entityId, details = {}, actor = 'HR Admin' }) {
  return AuditLog.create({ action, entityType, entityId, details, actor });
}

function generateCandidateQuestions(candidate, jd) {
  const skills = unique([...(candidate.skills || []), ...(jd?.requiredSkills || [])]).slice(0, 6);
  const experience = Number(candidate.experienceYears || jd?.minExperience || 1);
  const types = ['MCQ', 'Multiple Select', 'Descriptive', 'Scenario Based', 'Project Based'];
  const levels = ['Beginner', 'Intermediate', 'Advanced'];
  return skills.flatMap((skill, skillIndex) => levels.map((level, levelIndex) => ({
    id: `${candidate.id}-${skill.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${level.toLowerCase()}`,
    skill,
    level,
    type: types[(skillIndex + levelIndex) % types.length],
    question: level === 'Beginner'
      ? `Explain the core purpose of ${skill} in a ${candidate.roleApplied || jd?.title || 'software'} role.`
      : level === 'Intermediate'
        ? `Choose the best approach for using ${skill} in a production feature with ${experience}+ years of responsibility.`
        : `Design a project-level solution using ${skill}. Include risks, testing, and rollout steps.`,
    options: ['Strongly aligned', 'Partially aligned', 'Needs clarification', 'Not applicable'],
    answer: 'Strongly aligned'
  })));
}

function evaluateCandidateTest(test, answers = {}) {
  const questions = test.questions || [];
  const skillTotals = {};
  const skillCorrect = {};
  questions.forEach((question) => {
    skillTotals[question.skill] = (skillTotals[question.skill] || 0) + 1;
    const answer = answers[question.id];
    const text = Array.isArray(answer) ? answer.join(' ') : String(answer || '');
    const correct = question.answer ? answer === question.answer : text.trim().length >= 40;
    if (correct) skillCorrect[question.skill] = (skillCorrect[question.skill] || 0) + 1;
  });
  const skillBreakdown = Object.fromEntries(Object.keys(skillTotals).map((skill) => [skill, Math.round(((skillCorrect[skill] || 0) / skillTotals[skill]) * 100)]));
  const scores = Object.values(skillBreakdown);
  const score = scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 0;
  const strengths = Object.entries(skillBreakdown).filter(([, value]) => value >= 70).map(([skill]) => skill);
  const weaknesses = Object.entries(skillBreakdown).filter(([, value]) => value < 70).map(([skill]) => skill);
  const recommendation = score >= 75 ? 'Approve for interview or document collection.' : score >= 55 ? 'Review manually before next stage.' : 'Reject or request retake after admin review.';
  return { score, skillBreakdown, strengths, weaknesses, recommendation };
}

async function nextEmployeeCode() {
  const count = await Employee.count();
  return `ILXEMP-${String(count + 1).padStart(4, '0')}`;
}

async function officialEmailFor(name) {
  const base = String(name || 'employee').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/(^\.|\.$)/g, '') || 'employee';
  const domain = process.env.COMPANY_EMAIL_DOMAIN || 'infolinx.com';
  let email = `${base}@${domain}`;
  let suffix = 2;
  while (await Employee.findOne({ where: { email } })) {
    email = `${base}${suffix}@${domain}`;
    suffix += 1;
  }
  return email;
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

async function normalizeDemoEmails() {
  const oldDomain = ['company', 'local'].join('.');
  const replacements = [
    [`admin@${oldDomain}`, 'admin@company.com'],
    [`sai.kiran.reddy@${oldDomain}`, 'sai.kiran.reddy@company.com'],
    [`meera.krishnan@${oldDomain}`, 'sai.kiran.reddy@company.com'],
    [`priya.menon@${oldDomain}`, 'priya.menon@company.com'],
    [`rohan.iyer@${oldDomain}`, 'rohan.iyer@company.com'],
    [`sara.thomas@${oldDomain}`, 'sara.thomas@company.com']
  ];
  for (const [oldEmail, newEmail] of replacements) {
    await User.update({ email: newEmail }, { where: { email: oldEmail } });
    await Employee.update({ email: newEmail }, { where: { email: oldEmail } });
    await Panelist.update({ email: newEmail }, { where: { email: oldEmail } });
  }
  const mails = await MailLog.findAll({
    where: {
      [Op.or]: replacements.flatMap(([oldEmail]) => [
        { to: { [Op.iLike]: `%${oldEmail}%` } },
        { html: { [Op.iLike]: `%${oldEmail}%` } }
      ])
    }
  });
  for (const mail of mails) {
    let to = mail.to || '';
    let html = mail.html || '';
    for (const [oldEmail, newEmail] of replacements) {
      to = to.replaceAll(oldEmail, newEmail);
      html = html.replaceAll(oldEmail, newEmail);
    }
    await mail.update({ to, html });
  }
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
  const legacyOffers = await Offer.findAll({
    where: {
      [Op.or]: legacyMailReplacements.map(([oldValue]) => ({ html: { [Op.iLike]: `%${oldValue}%` } }))
    }
  });
  for (const offer of legacyOffers) {
    let html = offer.html || '';
    for (const [oldValue, newValue] of legacyMailReplacements) {
      html = html.replaceAll(oldValue, newValue);
    }
    await offer.update({ html });
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

async function ensureLearningDemoData() {
  const courses = [
    {
      title: 'Information Security and Data Privacy',
      category: 'Compliance',
      audience: 'All Employees',
      durationMinutes: 35,
      textContent: 'Protect company data, customer records, payroll information, resumes, offer letters and employee documents. Use strong passwords, avoid sharing credentials, and report suspicious emails immediately.',
      questions: [
        { id: 'q1', question: 'Which data should be treated as confidential?', options: ['Only payroll', 'Only resumes', 'Payroll, resumes, offers and employee documents'], answer: 'Payroll, resumes, offers and employee documents' },
        { id: 'q2', question: 'What should an employee do with a suspicious email?', options: ['Forward it externally', 'Report it to IT/HR', 'Ignore all emails'], answer: 'Report it to IT/HR' }
      ]
    },
    {
      title: 'Interview Panel Excellence',
      category: 'Recruitment',
      audience: 'Managers and Panelists',
      durationMinutes: 28,
      textContent: 'Panelists should review the JD, candidate CV, skills matrix and interview round before the meeting. Feedback must be structured, evidence based and submitted immediately after the interview.',
      questions: [
        { id: 'q1', question: 'When should interview feedback be submitted?', options: ['Immediately after interview', 'After offer release', 'After joining'], answer: 'Immediately after interview' },
        { id: 'q2', question: 'What should panel feedback be based on?', options: ['Guesswork', 'Evidence and role criteria', 'Salary expectation only'], answer: 'Evidence and role criteria' }
      ]
    },
    {
      title: 'Leave, Attendance and Payroll Basics',
      category: 'HR Operations',
      audience: 'All Employees',
      durationMinutes: 24,
      textContent: 'Employees must regularize attendance, apply leave in advance where possible, submit expense bills on time and verify payroll inputs before salary processing closes.',
      questions: [
        { id: 'q1', question: 'What affects monthly payroll calculation?', options: ['Attendance, leave and reimbursements', 'Only designation', 'Only employee name'], answer: 'Attendance, leave and reimbursements' },
        { id: 'q2', question: 'When should expenses be submitted?', options: ['After financial year only', 'With bills on time', 'Never'], answer: 'With bills on time' }
      ]
    }
  ];
  for (const course of courses) {
    const generated = generatedLearningMaterial(course);
    const [record] = await LearningCourse.findOrCreate({ where: { title: course.title }, defaults: { ...course, ...generated, videoUrl: null } });
    await record.update({ ...course, ...generated, videoUrl: null });
  }
}

async function ensureDepartmentSamples() {
  const departments = [
    { name: 'Product Engineering', code: 'ENG', head: 'Priya Menon', location: 'Hyderabad', description: 'Product development and platform delivery.' },
    { name: 'Design', code: 'DES', head: 'Lahari Naidu', location: 'Hyderabad / Remote', description: 'UX research, product design, and design systems.' },
    { name: 'Cloud Operations', code: 'OPS', head: 'Kavya Reddy', location: 'Hyderabad', description: 'Infrastructure, DevOps, monitoring, and releases.' },
    { name: 'Human Resources', code: 'HR', head: 'HR Admin', location: 'Hyderabad', description: 'Recruitment, onboarding, people operations, and payroll inputs.' }
  ];
  for (const department of departments) {
    const [record] = await Department.findOrCreate({ where: { name: department.name }, defaults: department });
    await record.update(department);
  }
}

async function ensureMasterRecordSamples() {
  const records = [
    { module: 'designation', name: 'Senior React Engineer', code: 'SRE', category: 'Engineering', owner: 'HR Admin', description: 'Senior frontend engineering role.' },
    { module: 'designation', name: 'Frontend Architect', code: 'FEA', category: 'Engineering', owner: 'HR Admin', description: 'Architecture and frontend standards.' },
    { module: 'company-policy', name: 'Recruitment Policy', code: 'POL-REC', category: 'HR', owner: 'HR Admin', description: 'Hiring approvals, interview flow and offer governance.' },
    { module: 'company-policy', name: 'Leave Policy', code: 'POL-LEV', category: 'HR', owner: 'HR Admin', description: 'Leave eligibility, approvals and payroll linkage.' },
    { module: 'holiday', name: "New Year's Day", code: 'HOL-001', category: 'National', effectiveDate: '2026-01-01', owner: 'HR Admin', description: 'Mandatory holiday.' },
    { module: 'holiday', name: 'Sankranti', code: 'HOL-002', category: 'Festival', effectiveDate: '2026-01-14', owner: 'HR Admin', description: 'Optional festival holiday.' },
    { module: 'biometric-device', name: 'Hyderabad Office', code: 'HYD-4343433', category: 'ZKTeco', status: 'Active', owner: 'Admin/Ops', description: 'Madhapur office attendance device.', metadata: { lastSync: 'Today 09:20', location: 'Madhapur' } },
    { module: 'attendance-regularisation', name: 'Missed Clock Out - Sai Kiran Reddy', code: 'REG-001', category: 'Missed Clock Out', status: 'Pending', owner: 'Priya Menon', effectiveDate: '2026-06-18', description: 'Forgot to clock out after production support call. Requested correction to 18:35.', metadata: { employeeName: 'Sai Kiran Reddy', employeeCode: 'EMP1001', actual: '09:42 - Missing', requested: '09:42 - 18:35', reason: 'Production support call continued after office hours', approver: 'Priya Menon' } },
    { module: 'attendance-regularisation', name: 'Late Arrival Approval - Sai Kiran Reddy', code: 'REG-002', category: 'Late Arrival', status: 'Approved', owner: 'Priya Menon', effectiveDate: '2026-06-17', description: 'Late arrival approved because of client-side deployment support the previous night.', metadata: { employeeName: 'Sai Kiran Reddy', employeeCode: 'EMP1001', actual: '10:28 - 18:40', requested: '09:30 - 18:40', reason: 'Late night deployment support', approver: 'Priya Menon' } },
    { module: 'attendance-regularisation', name: 'Work From Home Correction - Priya Menon', code: 'REG-003', category: 'Work Mode Correction', status: 'Rejected', owner: 'HR Admin', effectiveDate: '2026-06-16', description: 'Requested office day to be corrected as WFH. Rejected because manager approval was not attached.', metadata: { employeeName: 'Priya Menon', employeeCode: 'EMP1002', actual: 'Office', requested: 'Remote / WFH', reason: 'Worked from home due to internet maintenance at office bay', approver: 'HR Admin' } },
    { module: 'attendance-regularisation', name: 'Missed Clock In - Rohan Iyer', code: 'REG-004', category: 'Missed Clock In', status: 'Under Review', owner: 'Kumar', effectiveDate: '2026-06-15', description: 'Employee forgot morning punch; biometric exit and access logs are under review.', metadata: { employeeName: 'Rohan Iyer', employeeCode: 'EMP1003', actual: 'Missing - 18:10', requested: '09:55 - 18:10', reason: 'Biometric device not responding during entry', approver: 'Kumar' } },
    { module: 'billing', name: 'INV-202604-0016', code: 'APR-0016', category: 'Subscription', status: 'Overdue', amount: 0, effectiveDate: '2026-04-28', dueDate: '2026-05-03', owner: 'Finance Admin' },
    { module: 'billing', name: 'INV-202602-0009', code: 'FEB-0009', category: 'Subscription', status: 'Overdue', amount: 0, effectiveDate: '2026-02-27', dueDate: '2026-03-14', owner: 'Finance Admin' },
    { module: 'migration', name: 'Sample Data.xlsx', code: 'MIG-001', category: 'Employee Import', status: 'Completed', owner: 'HR Admin', description: 'Sample migration file processed.' }
  ];
  for (const record of records) {
    const [item] = await MasterRecord.findOrCreate({ where: { module: record.module, name: record.name }, defaults: record });
    await item.update(record);
  }
}

function skillSetForEmployee(employee, candidate) {
  if (candidate?.skills?.length) return candidate.skills;
  const text = `${employee.designation || ''} ${employee.department || ''}`.toLowerCase();
  if (text.includes('react') || text.includes('frontend')) return ['React', 'JavaScript', 'REST APIs', 'Testing', 'UI Architecture'];
  if (text.includes('node') || text.includes('backend')) return ['Node.js', 'Express', 'PostgreSQL', 'API Security', 'Testing'];
  if (text.includes('devops') || text.includes('cloud')) return ['AWS', 'Docker', 'Kubernetes', 'CI/CD', 'Monitoring'];
  if (text.includes('designer') || text.includes('design')) return ['Figma', 'Design Systems', 'User Research', 'Prototyping', 'SaaS'];
  if (text.includes('hr')) return ['HR Operations', 'Recruitment', 'Onboarding', 'Compliance', 'Employee Relations'];
  return ['Company Process', 'Communication', 'Security', 'Project Delivery', 'Documentation'];
}

function levelConfig(level) {
  return ({
    Beginner: { durationDays: 7, extensionDays: 3, progress: 0 },
    Intermediate: { durationDays: 10, extensionDays: 5, progress: 0 },
    Advanced: { durationDays: 20, extensionDays: 10, progress: 0 }
  })[level] || { durationDays: 7, extensionDays: 3, progress: 0 };
}

const learningContentLibrary = {
  React: { focus: 'component state, props, hooks, routing and UI testing' },
  JavaScript: { focus: 'language fundamentals, async flow, modules and browser behavior' },
  'REST APIs': { focus: 'request design, status codes, pagination, validation and error handling' },
  'UI Architecture': { focus: 'component boundaries, design systems and maintainable frontend delivery' },
  'Node.js': { focus: 'Express routing, services, validation, persistence and error handling' },
  Express: { focus: 'middleware, route handlers, controllers and API structure' },
  PostgreSQL: { focus: 'relational modeling, queries, indexes and transactions' },
  'API Security': { focus: 'authentication, authorization, input validation and secure API design' },
  Testing: { focus: 'test planning, assertions, automation and regression safety' },
  AWS: { focus: 'cloud services, IAM, deployment and operational monitoring' },
  Docker: { focus: 'images, containers, compose files and deployment repeatability' },
  Kubernetes: { focus: 'pods, services, deployments, scaling and rollout management' },
  'CI/CD': { focus: 'pipelines, build validation, release gates and rollback plans' },
  Monitoring: { focus: 'metrics, logs, alerts, dashboards and incident response' },
  Figma: { focus: 'frames, components, variants, prototypes and handoff' },
  'Design Systems': { focus: 'tokens, reusable components, accessibility and product consistency' },
  'User Research': { focus: 'interviews, usability testing, synthesis and decision support' },
  Prototyping: { focus: 'flows, interaction states and validation with stakeholders' },
  SaaS: { focus: 'subscription products, admin workflows, retention and operations' },
  'HR Operations': { focus: 'employee lifecycle, documentation, approvals and audit trails' },
  Recruitment: { focus: 'job requisitions, candidate screening, interviews and offer governance' },
  Onboarding: { focus: 'new hire setup, document collection, induction and readiness checks' },
  Compliance: { focus: 'policy adherence, records, controls and escalation paths' },
  'Employee Relations': { focus: 'employee communication, issue handling and manager partnership' },
  Security: { focus: 'data protection, phishing awareness, access control and incident reporting' },
  'Company Process': { focus: 'internal workflows, approvals, ownership and documentation' },
  Communication: { focus: 'clear updates, stakeholder alignment, escalation and written communication' },
  'Project Delivery': { focus: 'planning, execution, risks, reviews and delivery closure' },
  Documentation: { focus: 'clear records, handover notes, decisions and audit-ready evidence' }
};

function learningMaterialForSkill(skill) {
  return learningContentLibrary[skill] || {
    focus: `${skill} fundamentals, workplace application, checks and review evidence`
  };
}

function validateCurriculumMapping(curriculum) {
  const skills = new Set((curriculum.skills || []).map((skill) => String(skill).toLowerCase()));
  const errors = [];
  const belongsToSkill = (title = '') => [...skills].some((skill) => String(title).toLowerCase().includes(skill));
  for (const pdf of curriculum.pdfs || []) {
    if (!belongsToSkill(pdf.title)) errors.push(`PDF "${pdf.title}" is not mapped to a path skill.`);
  }
  for (const exercise of curriculum.exercises || []) {
    if (!belongsToSkill(exercise)) errors.push(`Exercise "${exercise}" is not mapped to a path skill.`);
  }
  for (const test of curriculum.tests || []) {
    for (const question of test.questions || []) {
      if (!skills.has(String(question.skill || '').toLowerCase())) errors.push(`Question skill "${question.skill}" is not in the path skill list.`);
    }
  }
  return errors;
}

function validateLearningCourseInput(payload = {}) {
  const title = String(payload.title || '').trim();
  const text = String(payload.textContent || '').trim();
  const category = String(payload.category || '').trim();
  const combined = `${title} ${category}`.toLowerCase();
  const content = `${text} ${String(payload.materialHtml || '')}`.toLowerCase();
  const topicTerms = unique([...title.split(/[^a-zA-Z0-9]+/), ...category.split(/[^a-zA-Z0-9]+/)])
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 3 && !['level', 'program', 'course', 'learning', 'training'].includes(term));
  const mismatchedTerms = ['react', 'javascript', 'node', 'express', 'payroll', 'attendance', 'security', 'privacy', 'interview', 'recruitment', 'compliance']
    .filter((term) => content.includes(term) && !combined.includes(term) && !topicTerms.includes(term));
  if (mismatchedTerms.length) {
    const error = new Error(`Learning content appears unrelated to the topic: ${mismatchedTerms.join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
}

function generatedLearningMaterial({ title = 'Workplace Learning Program', category = 'Technical', audience = 'All Employees', durationMinutes = 30 } = {}) {
  const safeTitle = String(title || 'Workplace Learning Program').trim();
  const safeCategory = String(category || 'Technical').trim();
  const safeAudience = String(audience || 'All Employees').trim();
  const duration = Number(durationMinutes || 30);
  const lower = `${safeTitle} ${safeCategory}`.toLowerCase();
  const focus = lower.includes('security') || lower.includes('privacy') || lower.includes('compliance')
    ? ['data classification', 'access discipline', 'incident reporting', 'audit evidence']
    : lower.includes('recruit') || lower.includes('interview')
      ? ['role clarity', 'candidate evidence', 'structured feedback', 'fair selection']
      : lower.includes('payroll') || lower.includes('attendance') || lower.includes('leave')
        ? ['attendance inputs', 'leave balance', 'payroll cut-off', 'employee self-service']
        : lower.includes('react') || lower.includes('javascript') || lower.includes('node') || lower.includes('api')
          ? ['core concepts', 'implementation standards', 'testing', 'production readiness']
          : ['workplace application', 'quality checks', 'ownership', 'documentation'];
  const summary = `This PDF learning guide prepares ${safeAudience} to understand ${safeTitle}, apply it in daily work, and complete a self assessment with practical evidence.`;
  const sections = [
    { heading: 'Learning Objectives', points: [`Understand the purpose, scope, vocabulary, and business impact of ${safeTitle}.`, `Apply ${focus[0]} and ${focus[1]} in realistic workplace situations.`, `Recognize common mistakes, risks, and escalation triggers before they become process failures.`, `Prepare for MCQ, checkbox, scenario, written, and practical assessment questions.`] },
    { heading: 'Core Concepts', points: [`${toSentence(focus[0])}: meaning, expected behavior, evidence needed, and example usage.`, `${toSentence(focus[1])}: minimum standard for employees, managers, and HR reviewers.`, `${toSentence(focus[2])}: what must be recorded, reported, reviewed, or approved.`, `${toSentence(focus[3])}: what proof is acceptable for audit, assessment, or manager review.`] },
    { heading: 'Detailed Notes', points: [`Start by identifying the process owner, expected input, expected output, approval role, and deadline. A large part of ${safeTitle} is not memorization; it is knowing what evidence proves the work was done correctly.`, `Every workplace process has normal cases and exception cases. Normal cases follow the standard steps. Exception cases require remarks, attachments, manager confirmation, or HR/Admin approval.`, `Good documentation is specific. Instead of writing "done", record what was checked, who approved it, when it was completed, and which evidence supports the decision.`] },
    { heading: 'Step-by-Step Practice', points: [`Read the policy, process note, or course material fully before starting related work.`, `List the owner, required inputs, approval path, expected output, and deadline.`, `Complete the work in HRMS and attach proof where required.`, `Review exceptions and escalate unclear cases to HR Admin, manager, IT, finance, or the correct process owner.`, `Before submission, verify that your answer explains both the decision and the evidence behind it.`] },
    { heading: 'Worked Example', points: [`Example: an employee receives a request related to ${safeTitle}. The employee first checks whether the request belongs to normal process or exception process.`, `If it is normal, the employee follows the standard checklist and records completion. If it is an exception, the employee adds remarks, evidence, and sends it to the right approver.`, `A strong assessment answer states: the risk, the correct step, the evidence required, and the escalation owner.`] },
    { heading: 'Common Mistakes', points: [`Answering only from memory without referring to policy or workflow evidence.`, `Submitting incomplete information, missing attachments, or vague remarks.`, `Approving or rejecting without stating a reason.`, `Ignoring timelines, cut-off dates, audit requirements, or confidentiality obligations.`, `Treating all cases as normal even when an exception approval is required.`] },
    { heading: 'Mini Case Study', points: [`A team member submits incomplete information two days before a cut-off. The reviewer must decide whether to process, return, reject, or escalate.`, `Correct approach: identify missing fields, check business impact, request the missing information, record a clear remark, and escalate if the cut-off or compliance risk is affected.`, `Assessment preparation: be ready to explain which action you chose and why it protects process quality.`] },
    { heading: 'Practice Activities', points: [`Create a one-page checklist for ${safeTitle}.`, `Write three examples of acceptable evidence and three examples of weak evidence.`, `Draft a short escalation message for an exception case.`, `Write a sample answer explaining how you would handle a delayed or incomplete request.`] },
    { heading: 'Glossary', points: [`Owner: the person accountable for completion or decision.`, `Evidence: document, record, timestamp, approval, attachment, or remark proving the action.`, `Exception: a case that cannot follow the normal process without approval or justification.`, `SLA: expected completion timeline.`, `Audit trail: history of who did what, when, and why.`] },
    { heading: 'Five-Day Study Plan', points: [`Day 1: Read overview, objectives, glossary, and core concepts.`, `Day 2: Study the step-by-step process and common mistakes.`, `Day 3: Practice the worked example and mini case study.`, `Day 4: Attempt practice activities and write your own scenario answers.`, `Day 5: Review checklist, evidence rules, and assessment pattern before taking the test.`] },
    { heading: 'Checklist Before Assessment', points: [`I can explain the objective of ${safeTitle}.`, `I can apply the process without using external video material.`, `I can identify risks, exceptions, evidence, and escalation points.`, `I can write a scenario answer that includes action, reason, owner, and proof.`, `I can answer MCQ, checkbox, written, and practical questions.`] }
  ];
  const questions = [
    { id: 'q1', question: `What is the primary outcome of ${safeTitle}?`, options: ['Apply the learning correctly at work', 'Skip the process', 'Only read the title'], answer: 'Apply the learning correctly at work' },
    { id: 'q2', question: `Which practice best supports ${safeTitle}?`, options: ['Document evidence and escalate exceptions', 'Share credentials freely', 'Avoid review'], answer: 'Document evidence and escalate exceptions' },
    { id: 'q3', question: `Write one workplace scenario where ${safeTitle} is important.`, type: 'textarea', answer: 'Scenario with correct process, evidence, and escalation' },
    { id: 'q4', question: `Select the items that should be checked before completing ${safeTitle}.`, type: 'checkbox', options: ['Required inputs', 'Approval owner', 'Evidence/attachments', 'Unverified assumptions'], answer: ['Required inputs', 'Approval owner', 'Evidence/attachments'] }
  ];
  const textContent = `${summary}\n\n${sections.map((section) => `${section.heading}\n${section.points.map((point) => `- ${point}`).join('\n')}`).join('\n\n')}`;
  const materialHtml = `
    <article class="learning-pdf-sheet">
      <header>
        <img src="/logo.png" alt="Infolinx" />
        <div><h1>${escapeHtml(safeTitle)}</h1><p>${escapeHtml(safeCategory)} | ${escapeHtml(safeAudience)} | ${duration} minutes</p></div>
      </header>
      <section><h2>Overview</h2><p>${escapeHtml(summary)}</p></section>
      ${sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2><ul>${section.points.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul></section>`).join('')}
      <section><h2>Assessment Pattern</h2><p>The assessment may include multiple choice, checkbox, written scenario, and practical workplace questions. Passing score is 70%.</p></section>
      <section><h2>Preparation Tip</h2><p>Before starting the test, revise the worked example, common mistakes, and evidence checklist. Strong answers should mention the correct action, why it is correct, the owner, and the proof needed.</p></section>
    </article>`;
  return {
    textContent,
    materialHtml,
    questions,
    pdfFileName: `${safeTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'learning-material'}.pdf`
  };
}

function learningReferenceMaterial({ skill, level, employee, focus }) {
  const title = `${skill} ${level} Reference PDF`;
  const role = employee.designation || 'Employee';
  const levelGuidance = {
    Beginner: 'focus on fundamentals, terms, simple examples, and safe execution',
    Intermediate: 'focus on independent application, troubleshooting, review quality, and edge cases',
    Advanced: 'focus on design decisions, governance, optimization, leadership, and production readiness'
  }[level] || 'focus on workplace application';
  const sections = [
    { heading: 'Purpose', body: `This reference prepares ${employee.name || 'the employee'} for ${skill} at ${level} level. It is written for a ${role} and connects the topic to HRMS product, people, and operations scenarios.` },
    { heading: 'What You Must Know', points: [`Definition and role of ${skill} in daily work.`, `Where ${skill} appears in HRMS workflows and product delivery.`, `Inputs, outputs, owners, evidence, and review checkpoints.`, `How to avoid common mistakes while applying ${skill}.`] },
    { heading: 'Concept Notes', points: [`At ${level} level, ${levelGuidance}.`, `The main focus area is ${focus}.`, `A good learner should be able to explain the concept, apply it to a practical scenario, and defend the decision using evidence.`, `When unsure, document the assumption and ask the right reviewer before moving forward.`] },
    { heading: 'Workplace Example', points: [`Scenario: a task requires ${skill} in an HRMS workflow. The employee must identify the requirement, check available data, complete the work, and submit evidence.`, `Good answer: explains the steps, expected output, test or verification method, and escalation route.`, `Weak answer: gives only a definition without showing how it applies to work.`] },
    { heading: 'Common Mistakes', points: [`Skipping fundamentals and jumping directly to the final answer.`, `Missing validation, review, documentation, or exception handling.`, `Not connecting ${skill} to the employee's actual role.`, `Submitting incomplete work without evidence or clear remarks.`] },
    { heading: 'Practice Exercises', points: [`Write a 150-word explanation of ${skill} for your role.`, `Create a checklist for using ${skill} in one HRMS scenario.`, `List three risks and how you will prevent them.`, `Prepare one MCQ, one scenario answer, and one practical answer for self-review.`] },
    { heading: 'Assessment Preparation', points: [`Remember the definition, process, examples, mistakes, and evidence.`, `For scenario questions, answer in this order: situation, action, reason, proof, escalation.`, `For checkbox questions, choose only options that are necessary, verifiable, and policy-aligned.`, `For written answers, avoid vague language and include concrete workplace details.`] }
  ];
  return `<article class="learning-pdf-sheet"><header><img src="/logo.png" alt="Infolinx" /><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(level)} Level | ${escapeHtml(role)} | Infolinx Learning</p></div></header>${sections.map((section) => `<section><h2>${escapeHtml(section.heading)}</h2>${section.body ? `<p>${escapeHtml(section.body)}</p>` : ''}${section.points ? `<ul>${section.points.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>` : ''}</section>`).join('')}</article>`;
}

function toSentence(value = '') {
  const text = String(value || '').trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
}

function buildLearningCurriculum({ employee, candidate, level }) {
  const skills = skillSetForEmployee(employee, candidate).slice(0, 5);
  const levelText = level.toLowerCase();
  const curriculum = {
    skills,
    pdfs: skills.slice(0, 4).map((skill) => ({
      title: `${skill} ${level} Reference PDF`,
      topic: skill,
      url: `/learning-materials/${employee.employeeCode || 'employee'}-${levelText}-${skill.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`,
      materialHtml: learningReferenceMaterial({ skill, level, employee, focus: learningMaterialForSkill(skill).focus })
    })),
    exercises: skills.slice(0, 4).map((skill, index) => `${level} exercise ${index + 1}: apply ${skill} to an HRMS product scenario. Focus: ${learningMaterialForSkill(skill).focus}.`),
    tests: [1, 2, 3].map((testNo) => ({
      id: `${levelText}-test-${testNo}`,
      title: `${level} Assessment ${testNo}`,
      day: Math.ceil((levelConfig(level).durationDays / 3) * testNo),
      status: 'Pending',
      score: null,
      questions: skills.slice(0, 3).map((skill, index) => ({
        id: `${levelText}-${testNo}-${index + 1}`,
        skill,
        type: index === 0 ? 'MCQ' : index === 1 ? 'Scenario Based' : 'Project Based',
        question: `${level} ${skill}: explain or solve a realistic task for ${employee.designation || 'your role'}.`
      }))
    }))
  };
  const mappingErrors = validateCurriculumMapping(curriculum);
  if (mappingErrors.length) throw new Error(`Learning content mapping failed: ${mappingErrors.join(' ')}`);
  return curriculum;
}

async function generateLearningLifecycle(employee) {
  const candidate = employee.CandidateId ? await Candidate.findByPk(employee.CandidateId) : null;
  const levels = ['Beginner', 'Intermediate', 'Advanced'];
  const paths = [];
  for (const [index, level] of levels.entries()) {
    const config = levelConfig(level);
    const curriculum = buildLearningCurriculum({ employee, candidate, level });
    const [path] = await LearningPath.findOrCreate({
      where: { EmployeeId: employee.id, level },
      defaults: {
        EmployeeId: employee.id,
        level,
        title: `${employee.designation || 'Employee'} ${level} Career Track`,
        durationDays: config.durationDays,
        extensionDays: config.extensionDays,
        curriculum,
        roadmap: 'Beginner -> Intermediate -> Advanced -> Mini Project -> Certification -> Core Team Tasks',
        status: index === 0 ? 'In Progress' : 'Locked',
        progress: config.progress,
        assessmentsPassed: 0,
        dueDate: new Date(Date.now() + config.durationDays * 86400000).toISOString().slice(0, 10)
      }
    });
    await path.update({
      title: `${employee.designation || 'Employee'} ${level} Career Track`,
      durationDays: config.durationDays,
      extensionDays: config.extensionDays,
      curriculum,
      roadmap: 'Beginner -> Intermediate -> Advanced -> Mini Project -> Certification -> Core Team Tasks',
      progress: Number(path.assessmentsPassed || 0) === 0 ? 0 : path.progress,
      dueDate: path.dueDate || new Date(Date.now() + config.durationDays * 86400000).toISOString().slice(0, 10)
    });
    paths.push(path);
  }
  return paths;
}

async function ensureLifecycleDemoData() {
  const employees = await Employee.findAll({ limit: 3, order: [['createdAt', 'DESC']] });
  for (const employee of employees) {
    await generateLearningLifecycle(employee);

    await ExtensionRequest.findOrCreate({
      where: { EmployeeId: employee.id, requestType: 'Learning Extension' },
      defaults: {
        EmployeeId: employee.id,
        requestType: 'Learning Extension',
        requestedDays: 3,
        reason: 'Need extra time for practical exercises.',
        status: 'Pending'
      }
    });

    const [project] = await ProjectAssignment.findOrCreate({
      where: { EmployeeId: employee.id, title: 'Mini HRMS Workflow Project' },
      defaults: {
        EmployeeId: employee.id,
        title: 'Mini HRMS Workflow Project',
        description: 'Build a small workflow that connects learning completion, task updates, and HR review.',
        deliverables: 'Repository link, short demo notes, test evidence, and deployment checklist.',
        evaluationCriteria: 'Functional completeness, code quality, testing, documentation, and review response.',
        status: 'Assigned'
      }
    });

    const [board] = await SprintBoard.findOrCreate({
      where: { EmployeeId: employee.id, name: 'Core Team Sprint 1' },
      defaults: {
        EmployeeId: employee.id,
        name: 'Core Team Sprint 1',
        sprintGoal: 'Move onboarding graduate into production-style delivery.',
        startDate: new Date().toISOString().slice(0, 10),
        endDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)
      }
    });

    const taskTitles = ['Prepare project plan', 'Implement candidate test report', 'Submit daily update', 'Review sprint demo'];
    for (const [index, title] of taskTitles.entries()) {
      await WorkTask.findOrCreate({
        where: { EmployeeId: employee.id, SprintBoardId: board.id, title },
        defaults: {
          EmployeeId: employee.id,
          SprintBoardId: board.id,
          title,
          description: `${title} for ${project.title}.`,
          storyPoints: index + 2,
          priority: index === 1 ? 'High' : 'Medium',
          status: ['To Do', 'In Progress', 'Review', 'Testing'][index],
          timesheetHours: index
        }
      });
    }

    await Certification.findOrCreate({
      where: { EmployeeId: employee.id, title: 'HRMS Core Team Readiness' },
      defaults: { EmployeeId: employee.id, title: 'HRMS Core Team Readiness', level: 'Advanced', status: 'In Progress' }
    });
  }
}

function escapeHtml(value = '') {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatInr(value = 0) {
  return Number(Math.round(Number(value || 0))).toLocaleString('en-IN');
}

function formatOfferDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function numberToIndianWords(value = 0) {
  const number = Math.round(Number(value || 0));
  if (!number) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const belowHundred = (num) => (num < 20 ? ones[num] : `${tens[Math.floor(num / 10)]}${num % 10 ? ` ${ones[num % 10]}` : ''}`);
  const belowThousand = (num) => `${num >= 100 ? `${ones[Math.floor(num / 100)]} Hundred${num % 100 ? ' ' : ''}` : ''}${num % 100 ? belowHundred(num % 100) : ''}`;
  const parts = [
    [10000000, 'Crore'],
    [100000, 'Lakh'],
    [1000, 'Thousand'],
    [1, '']
  ];
  let remaining = number;
  return parts.map(([divisor, label]) => {
    const count = Math.floor(remaining / divisor);
    remaining %= divisor;
    return count ? `${belowThousand(count)}${label ? ` ${label}` : ''}` : '';
  }).filter(Boolean).join(' ');
}

function calculateOfferBreakup(annualCtc = 0) {
  const ctc = Math.round(Number(annualCtc || 0));
  const rows = [
    { component: 'Basic Salary', annual: Math.round(ctc * 0.40) },
    { component: 'House Rent Allowance', annual: Math.round(ctc * 0.20) },
    { component: 'Special Allowance / Flexible Pay', annual: Math.round(ctc * (8 / 30)) },
    { component: 'Performance / Statutory Bonus', annual: 0 }
  ];
  rows[3].annual = ctc - rows.slice(0, 3).reduce((sum, row) => sum + row.annual, 0);
  return {
    currency: 'INR',
    rows: rows.map((row) => ({ ...row, monthly: Math.round(row.annual / 12) })),
    policyBenefits: 'Included as per policy',
    totalAnnual: ctc,
    totalMonthly: Math.round(ctc / 12)
  };
}

function offerHtml({ candidate, offer }) {
  const salary = calculateOfferBreakup(offer.annualCtc);
  const today = new Date().toISOString().slice(0, 10);
  const offerDate = formatOfferDate(offer.offerDate || today);
  const joiningDate = formatOfferDate(offer.joiningDate);
  const acceptanceDue = formatOfferDate(offer.acceptanceDueDate || offer.joiningDate);
  const name = escapeHtml(candidate.name);
  const salutation = name.toLowerCase().startsWith('mr.') || name.toLowerCase().startsWith('ms.') ? name : `Mr./Ms. ${name}`;
  const designation = escapeHtml(offer.designation || candidate.roleApplied || 'Employee');
  const department = escapeHtml(offer.department || 'Product Engineering');
  const workLocation = escapeHtml(offer.workLocation || 'Hyderabad, Telangana');
  const primaryCity = escapeHtml((offer.workLocation || 'Hyderabad').split(',')[0]);
  const address = escapeHtml(offer.candidateAddress || 'Address as provided by candidate').replaceAll('\n', '<br/>');
  const reportingManager = escapeHtml(offer.reportingManager || 'Hiring Manager');
  const hrName = escapeHtml(offer.hrName || 'HR Admin');
  const bandLevel = escapeHtml(offer.bandLevel || 'To be filled by HR');
  const noticePeriod = escapeHtml(offer.noticePeriod || '30 days');
  const probationPeriod = escapeHtml(offer.probationPeriod || 'As per company policy');
  const ref = `INFOLINX/OFFER/${new Date().getFullYear()}/${candidate.id || 'CAND'}`;
  const rowHtml = salary.rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.component)}</td>
      <td class="amount">INR ${formatInr(row.monthly)}</td>
      <td class="amount">INR ${formatInr(row.annual)}</td>
    </tr>`).join('');
  return `
    <article class="offer-letter-doc" style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.52;max-width:860px;margin:auto;background:#fff;border:1px solid #dbe3ed;padding:34px">
      <style>
        .offer-letter-doc h1{font-size:22px;text-align:center;margin:8px 0 20px;color:#0b2f4f;text-decoration:underline}
        .offer-letter-doc h2{font-size:16px;margin:24px 0 8px;color:#0b2f4f}
        .offer-letter-doc h3{font-size:14px;margin:16px 0 6px;color:#0b2f4f}
        .offer-letter-doc p,.offer-letter-doc li{font-size:12.5px;margin:7px 0}
        .offer-letter-doc .muted{color:#64748b}
        .offer-letter-doc .letterhead{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:3px solid #f08a00;padding-bottom:14px;margin-bottom:18px}
        .offer-letter-doc .letterhead img{height:58px;object-fit:contain}
        .offer-letter-doc .meta{text-align:right;font-size:12px;color:#334155}
        .offer-letter-doc .subject{font-weight:700;text-decoration:underline;margin:18px 0 12px}
        .offer-letter-doc table{width:100%;border-collapse:collapse;margin:10px 0 16px;font-size:12px}
        .offer-letter-doc th{background:#0b2f4f;color:#fff;text-align:left;padding:9px;border:1px solid #0b2f4f}
        .offer-letter-doc td{padding:8px;border:1px solid #cbd5e1;vertical-align:top}
        .offer-letter-doc .amount{text-align:right;white-space:nowrap}
        .offer-letter-doc .total-row td{font-weight:700;background:#fff7ed}
        .offer-letter-doc .signature-grid{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:24px}
        .offer-letter-doc .acceptance{border:1px solid #dbe3ed;background:#f8fafc;padding:14px;margin-top:18px}
        .offer-letter-doc .page-break{break-before:page;border-top:1px dashed #cbd5e1;margin-top:26px;padding-top:20px}
      </style>
      <div class="letterhead">
        <img src="/logo.png" alt="Infolinx" />
        <div class="meta">
          <strong>Infolinx</strong><br/>
          Hyderabad, Telangana, India<br/>
          Email: hr@infolinx.com
        </div>
      </div>
      <h1>OFFER OF APPOINTMENT</h1>
      <p><strong>Ref:</strong> ${ref}</p>
      <p><strong>Date:</strong> ${offerDate}</p>
      <p>To,<br/><strong>${salutation}</strong><br/>${address}<br/>Phone No.: ${escapeHtml(candidate.phone || 'As provided')}</p>
      <p class="subject">Subject: Offer of Appointment</p>
      <p>Dear ${salutation},</p>
      <p>With reference to the discussions and selection process completed with you, we are pleased to offer you employment with our organization as <strong>${designation}</strong>, based out of our <strong>${workLocation}</strong> office. Your employment will be subject to the terms, conditions, policies, processes, and practices of Infolinx as applicable from time to time.</p>
      <p>Your primary place of work shall be <strong>${primaryCity}</strong>. However, depending on project needs, business requirements, client requirements, or internal operational needs, Infolinx may require you to work from any company office, client location, remote location, or any other location within India or outside India. Any travel undertaken for official work shall be governed by the applicable travel and expense policy of the Company.</p>
      <p>The detailed compensation structure and related notes are provided in <strong>Annexure A - Compensation Structure</strong>. Your salary and benefits shall be subject to statutory deductions, applicable taxes, company policies, and regulatory requirements as amended from time to time.</p>
      <h2>Confidentiality of Compensation</h2>
      <p>Your compensation details are confidential and are intended only for you and the authorized representatives of Infolinx. You are expected not to disclose, circulate, publish, or discuss your compensation package with any unauthorized person, employee, client, vendor, or third party in any manner whatsoever.</p>
      <h2>Governing Terms</h2>
      <p>Your employment with Infolinx shall be governed by this Offer of Appointment, the annexures attached herewith, your employment agreement, applicable policies, employee handbook, code of conduct, and any rules or instructions issued by the Company from time to time.</p>
      <h2>Date of Joining</h2>
      <p>You are required to join Infolinx on <strong>${joiningDate || 'the joining date confirmed by HR'}</strong> through the joining process communicated by HR. Unless the joining date is extended in writing by the Company, this offer may stand withdrawn if you do not join on or before the above-mentioned date.</p>
      <h2>Reporting</h2>
      <p>On the day of joining, you are requested to report to <strong>${reportingManager}</strong> to complete the joining formalities. Your probation period will be <strong>${probationPeriod}</strong> and your notice period will be <strong>${noticePeriod}</strong>, unless modified by employment agreement or company policy.</p>
      <h2>Acknowledge & Accept</h2>
      <p>Kindly acknowledge acceptance of this Offer of Appointment by signing and returning the acceptance copy to <strong>${hrName}</strong> latest by <strong>${acceptanceDue || 'the due date communicated by HR'}</strong>.</p>
      <h2>Joining and Onboarding Formalities</h2>
      <p>On the date of joining, you are required to complete all onboarding formalities as instructed by the HR Department. You shall submit copies of all required documents and originals for verification, wherever required, as listed in Annexure D - Checklist of Documents.</p>
      <h2>Background Verification</h2>
      <p>This offer and your continued employment are subject to successful background verification, reference checks, educational verification, identity verification, previous employment verification, and such other checks as may be considered necessary by Infolinx or its authorized verification partners.</p>
      <h2>Compensation</h2>
      <p>Your total annual compensation / Cost to Company shall be <strong>INR ${formatInr(salary.totalAnnual)} (${numberToIndianWords(salary.totalAnnual)} only) per annum</strong>.</p>
      <h2>Enclosures</h2>
      <ul>
        <li>Annexure A - Compensation Structure</li>
        <li>Annexure B - Important Terms and Conditions of Employment</li>
        <li>Annexure C - Medical Self Declaration</li>
        <li>Annexure D - Checklist of Documents</li>
        <li>Annexure E - Confidentiality Agreement</li>
        <li>Annexure F - Intellectual Property Assignment</li>
        <li>Annexure G - General Covenant Against Disclosure, Non-Compete and Non-Solicitation</li>
        <li>Annexure H - Code of Conduct and Ethics Acceptance</li>
      </ul>
      <div class="signature-grid">
        <p>For Infolinx<br/><br/><strong>Human Resources Department</strong><br/>Hyderabad, Telangana, India</p>
        <p>Accepted by Candidate<br/><br/>Name: <strong>${name}</strong><br/>Date: __________________<br/>Signature / Digital Acceptance: __________________</p>
      </div>
      <section class="page-break">
        <h2>ANNEXURE A - COMPENSATION STRUCTURE</h2>
        <p><strong>Name:</strong> ${salutation}<br/><strong>Title:</strong> ${designation}<br/><strong>Band / Level:</strong> ${bandLevel}<br/><strong>Department:</strong> ${department}<br/><strong>Location:</strong> ${workLocation}<br/><strong>Compensation Period:</strong> ${escapeHtml(offer.compensationPeriod || 'Per Annum')}<br/><strong>Currency:</strong> Indian Rupees</p>
        <table>
          <thead><tr><th>Component</th><th class="amount">Amount Per Month (INR)</th><th class="amount">Amount Per Annum (INR)</th></tr></thead>
          <tbody>
            ${rowHtml}
            <tr><td>Employer Contribution to Statutory Benefits, Insurance, Gratuity or Other Benefits</td><td colspan="2">${salary.policyBenefits}</td></tr>
            <tr class="total-row"><td>Total Cost to Company</td><td class="amount">INR ${formatInr(salary.totalMonthly)}</td><td class="amount">INR ${formatInr(salary.totalAnnual)}</td></tr>
          </tbody>
        </table>
        <h3>Salary Payment</h3>
        <p>Your salary shall be paid monthly through bank transfer into the salary account designated by you and approved by the Company. Salary processing shall be subject to regular attendance, submission of joining documents, completion of payroll requirements, valid PAN details, bank account details, statutory declarations, and such other information as required by the Company.</p>
        <h3>Compensation Notes</h3>
        <p>Bonus, statutory bonus, performance bonus, provident fund, gratuity, leave encashment, and other benefits shall be governed by applicable law and company policy. All payments shall be subject to deduction of tax at source and other statutory deductions.</p>
      </section>
      <section class="page-break">
        <h2>ANNEXURE B - IMPORTANT TERMS AND CONDITIONS OF EMPLOYMENT</h2>
        <h3>Employment Agreement and Code of Conduct</h3>
        <p>During the period of your employment, you shall perform your duties honestly, faithfully, diligently, efficiently, and in the best interests of Infolinx. You shall conduct yourself in a professional manner and comply with the employee handbook, code of conduct, information security requirements, attendance rules, leave rules, payroll rules, and all policies issued by the Company from time to time.</p>
        <h3>Secrecy, Confidentiality and Data Privacy</h3>
        <p>You shall maintain strict secrecy and confidentiality regarding the affairs of the Company, its affiliates, clients, vendors, employees, business processes, technology, software, source code, designs, data, financial information, customer information, pricing, proposals, project documentation, trade secrets, know-how, and any other confidential information accessed during your employment.</p>
        <p>By accepting this offer and providing your personal data to Infolinx, you consent to the Company collecting, storing, processing, using, transferring, and retaining your personal information and sensitive personal information for employment, payroll, statutory compliance, background verification, benefits administration, insurance, internal records, security, audits, legal compliance, and other legitimate business purposes.</p>
        <h3>Conflict of Interest, Non-Solicitation and Non-Compete</h3>
        <p>Your employment with Infolinx is full-time employment. You shall not, without prior written approval, engage in employment, consultancy, freelancing, business activity, directorship, agency relationship, or any commercial activity that may conflict with your role, affect your performance, compete with the Company, or create a conflict of interest.</p>
        <p>During employment and for a reasonable period after cessation of employment, subject to applicable law, you shall not solicit business from clients, interfere with Company relationships, solicit employees or service providers, or use confidential information for personal gain or for the benefit of any third party.</p>
        <h3>Assignment, Transfer, Notice and Termination</h3>
        <p>Infolinx may assign, transfer, depute, second, or allocate you to any department, project, client location, affiliate, branch, worksite, or business unit in India or abroad. Either party may terminate employment by giving <strong>${noticePeriod}</strong> written notice or salary in lieu of notice, unless otherwise specified by agreement, project requirement, policy, or applicable law.</p>
      </section>
      <section class="page-break">
        <h2>ANNEXURE C - MEDICAL SELF DECLARATION</h2>
        <p>I declare that the medical information submitted by me to Infolinx is true and complete to the best of my knowledge. I understand that employment may be subject to medical fitness requirements wherever applicable by role, client, project, law, or policy.</p>
        <table>
          <thead><tr><th>Medical Details</th><th>Yes</th><th>No</th><th>Details</th></tr></thead>
          <tbody>
            <tr><td>Vision, hearing, physical disability, congenital disorder, psychiatric condition, substance dependency, employment medical rejection, critical illness, surgery, or any medical condition requiring extended leave.</td><td></td><td></td><td></td></tr>
            <tr><td>Heart attack, diabetes, high blood pressure, stroke, asthma, slipped disc, night blindness, valve disorder, cancer, tumour, cyst, or similar growth.</td><td></td><td></td><td></td></tr>
          </tbody>
        </table>
      </section>
      <section class="page-break">
        <h2>ANNEXURE D - CHECKLIST OF DOCUMENTS</h2>
        <table>
          <thead><tr><th>Document</th><th>Status</th><th>HR Verification</th></tr></thead>
          <tbody>
            ${['Aadhaar / Identity Proof', 'PAN Card', 'Passport Photograph', 'Address Proof', 'Education Certificates', 'Previous Offer Letter', 'Previous Relieving Letter', 'Previous Payslips', 'Bank Details / Cancelled Cheque', 'Form 16, if applicable', 'Emergency Contact Details', 'Signed Offer Letter'].map((item) => `<tr><td>${item}</td><td>To be submitted</td><td>Pending</td></tr>`).join('')}
          </tbody>
        </table>
      </section>
      <section class="page-break">
        <h2>ANNEXURE E - CONFIDENTIALITY AGREEMENT</h2>
        <p>I, <strong>${name}</strong>, agree that all confidential information disclosed to me or accessed by me during employment shall remain the property of Infolinx or its clients. I shall not disclose, copy, transmit, publish, misuse, retain, or make available confidential information to any unauthorized person. On termination of employment or whenever requested, I shall promptly return all confidential information, documents, devices, records, manuals, notes, storage media, source code, designs, customer records, and all copies in my possession or control.</p>
        <p>This confidentiality obligation shall continue during and after my employment.</p>
      </section>
      <section class="page-break">
        <h2>ANNEXURE F - INTELLECTUAL PROPERTY ASSIGNMENT</h2>
        <p>I hereby assign to Infolinx, its successors, nominees, clients, designees, or assigns, all rights, title, and interest in any invention, discovery, software, design, architecture, process, method, framework, improvement, documentation, database, configuration, code, script, tool, product, system, report, model, research output, copyrightable work, patentable work, or other intellectual property that I create, develop, contribute to, modify, discover, or assist in creating during the course of my employment.</p>
        <p>Infolinx shall be the first owner of copyright in all works created in the course of my employment. I shall sign all documents and perform all acts reasonably required by Infolinx to register, protect, transfer, perfect, defend, or enforce such rights.</p>
      </section>
      <section class="page-break">
        <h2>ANNEXURE G - GENERAL COVENANT AGAINST DISCLOSURE, NON-COMPETE AND NON-SOLICITATION</h2>
        <p>In consideration of my employment with Infolinx and the salary, benefits, training, exposure, experience, and opportunities provided to me, I agree to perform all duties competently, diligently, reliably, ethically, and to the best of my ability. I shall not engage in competing activity, misuse confidential information, solicit customers, induce employees or associates to leave the Company, or accept conflicting assignments in a manner that adversely affects Infolinx.</p>
        <p>Each paragraph and provision of this agreement is severable. The agreement shall be governed by and interpreted in accordance with the laws of India, and the parties submit to the jurisdiction of competent courts at Hyderabad, Telangana, India, unless otherwise required by law.</p>
      </section>
      <section class="page-break">
        <h2>ANNEXURE H - PROOF OF ACCEPTANCE OF CODE OF ETHICAL BUSINESS CONDUCT AND POLICY COMPLIANCE</h2>
        <p>I, <strong>${name}</strong>, acknowledge that I have received, read, understood, and agreed to comply with the Code of Ethical Business Conduct, employment policies, information security rules, confidentiality requirements, data privacy obligations, anti-bribery requirements, anti-harassment rules, insider information restrictions where applicable, and all other policies communicated by Infolinx.</p>
        <p>I shall conduct myself with integrity, comply with laws, avoid conflict of interest, protect company assets, maintain accurate records, report suspected violations, and understand that violation of policy, employment terms, confidentiality obligations, or applicable law may result in disciplinary action including warning, suspension, recovery, termination, and legal proceedings.</p>
      </section>
      <section class="acceptance">
        <h2>Final Employee Declaration</h2>
        <p>I, <strong>${name}</strong>, confirm that I have read and understood the Offer of Appointment and all annexures, accept the position of <strong>${designation}</strong> with Infolinx, accept the total annual compensation of <strong>INR ${formatInr(salary.totalAnnual)}</strong> per annum, and agree to join on <strong>${joiningDate || 'the joining date confirmed by HR'}</strong>.</p>
      </section>
    </article>`;
}

function offerDocumentHtml(offer) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Offer Letter</title></head><body>${offer.html || ''}</body></html>`;
}

function offerDispatchEmailHtml({ candidate, offer }) {
  const joining = formatOfferDate(offer.joiningDate);
  const ctc = formatInr(offer.annualCtc);
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.55">
      <p>Dear ${escapeHtml(candidate.name)},</p>
      <p>Congratulations. We are pleased to share your offer of appointment for the position of <strong>${escapeHtml(offer.designation || candidate.roleApplied || 'Employee')}</strong> with Infolinx.</p>
      <p>Please find the offer letter attached and review the appointment terms, compensation annexure, joining formalities, document checklist, confidentiality obligations, and acceptance declaration.</p>
      <table style="border-collapse:collapse;margin:14px 0;font-size:14px">
        <tr><td style="border:1px solid #dbe3ed;padding:8px"><strong>Joining Date</strong></td><td style="border:1px solid #dbe3ed;padding:8px">${joining || 'As discussed with HR'}</td></tr>
        <tr><td style="border:1px solid #dbe3ed;padding:8px"><strong>Designation</strong></td><td style="border:1px solid #dbe3ed;padding:8px">${escapeHtml(offer.designation || 'Employee')}</td></tr>
        <tr><td style="border:1px solid #dbe3ed;padding:8px"><strong>Annual CTC</strong></td><td style="border:1px solid #dbe3ed;padding:8px">INR ${ctc}</td></tr>
      </table>
      <p>Kindly confirm acceptance by replying to this email or through the HRMS candidate/employee portal as instructed by HR.</p>
      <p>Regards,<br/><strong>${escapeHtml(offer.hrName || 'HR Admin')}</strong><br/>Human Resources<br/>Infolinx</p>
    </div>`;
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

function calculateHours(startTime = '00:00', endTime = '00:00') {
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);
  const start = startHour * 60 + startMinute;
  let end = endHour * 60 + endMinute;
  if (end < start) end += 24 * 60;
  return Number(((end - start) / 60).toFixed(2));
}

async function ensureDemoEmployee() {
  const demoEmployee = {
    employeeCode: 'EMP1001',
    name: 'Sai Kiran Reddy',
    email: 'sai.kiran.reddy@company.com',
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
    const oldDomain = ['company', 'local'].join('.');
    const oldUser = await User.findOne({ where: { email: `meera.krishnan@${oldDomain}` } });
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
    await ensurePayrollSamples(existing);
    await ensureAttendanceSamples(existing);
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
  await ensurePayrollSamples(employee);
  await ensureAttendanceSamples(employee);
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

async function ensurePayrollSamples(employee) {
  const samples = [
    { month: '2026-05', grossPay: 150000, deductions: 22000, reimbursements: 2500, netPay: 130500, status: 'Reviewed' },
    { month: '2026-04', grossPay: 150000, deductions: 21500, reimbursements: 1800, netPay: 130300, status: 'Paid' }
  ];
  for (const sample of samples) {
    const [run] = await PayrollRun.findOrCreate({
      where: { EmployeeId: employee.id, month: sample.month },
      defaults: { ...sample, EmployeeId: employee.id }
    });
    await run.update(sample);
  }
}

async function ensureAttendanceSamples(employee) {
  const samples = [
    { date: '2026-05-01', checkIn: '09:42', checkOut: '18:35', totalHours: 8.88, status: 'Present', workMode: 'Office', clockInLocation: 'Hyderabad Office', clockOutLocation: 'Hyderabad Office', remarks: 'Full day recorded' },
    { date: '2026-05-02', checkIn: '10:05', checkOut: '18:20', totalHours: 8.25, status: 'Late', workMode: 'Office', clockInLocation: 'Hyderabad Office', clockOutLocation: 'Hyderabad Office', remarks: 'Late clock in' },
    { date: '2026-05-03', checkIn: '09:30', checkOut: '18:40', totalHours: 9.17, status: 'Present', workMode: 'Remote', clockInLocation: 'Remote - Hyderabad', clockOutLocation: 'Remote - Hyderabad', remarks: 'Work from home' }
  ];
  for (const sample of samples) {
    const [record] = await AttendanceRecord.findOrCreate({
      where: { EmployeeId: employee.id, date: sample.date },
      defaults: { ...sample, EmployeeId: employee.id }
    });
    await record.update(sample);
  }
}

async function seed() {
  await normalizeDemoEmails();
  const adminEmail = process.env.MAIL_FROM || process.env.MS_GRAPH_MAIL_USER_ID || process.env.MS_GRAPH_USER_ID || 'Info@infolinx.com';
  const legacyAdmin = await User.findOne({ where: { email: 'admin@company.com' } });
  if (legacyAdmin && legacyAdmin.email !== adminEmail) await legacyAdmin.update({ email: adminEmail, name: 'HR Admin' });
  const admin = await User.findOne({ where: { email: adminEmail } });
  if (!admin) {
    await User.create({
      name: 'HR Admin',
      email: adminEmail,
      passwordHash: await bcrypt.hash('Admin@2026', 10),
      role: 'HR Admin',
      portalAccess: 'admin',
      mustChangePassword: false
    });
  }
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await sequelize.authenticate();
  res.json({ ok: true, database: process.env.DB_NAME });
}));

app.get('/api/bootstrap', asyncRoute(async (_req, res) => {
  const [jds, candidates, panelists, interviews, offers, employees, mails, learningCourses, learningAttempts, departments, masterRecords, candidateTests, candidateOnboardingDocuments, extensionRequests, projectAssignments, sprintBoards, workTasks, certifications, auditLogs] = await Promise.all([
    JobDescription.findAll({ order: [['createdAt', 'DESC']] }),
    Candidate.findAll({ include: [JobDescription, Offer, CandidateTest, CandidateOnboardingDocument], order: [['updatedAt', 'DESC']] }),
    Panelist.findAll({ order: [['name', 'ASC']] }),
    Interview.findAll({ include: [Candidate, Panelist], order: [['scheduledAt', 'DESC']] }),
    Offer.findAll({ include: [Candidate], order: [['updatedAt', 'DESC']] }),
    Employee.findAll({ include: [OnboardingTask, BgvCheck, PayrollRun, LeaveRequest, ExpenseClaim, RelievingCase, AttendanceRecord, PerformanceReview, GeneratedLetter, FinalSettlement, Notification, LearningPath, ExtensionRequest, ProjectAssignment, SprintBoard, WorkTask, Certification], order: [['createdAt', 'DESC']] }),
    MailLog.findAll({ order: [['createdAt', 'DESC']], limit: 50 }),
    LearningCourse.findAll({ order: [['category', 'ASC'], ['title', 'ASC']] }),
    LearningAttempt.findAll({ include: [LearningCourse, Employee], order: [['completedAt', 'DESC']], limit: 30 }),
    Department.findAll({ order: [['name', 'ASC']] }),
    MasterRecord.findAll({ order: [['module', 'ASC'], ['name', 'ASC']] }),
    CandidateTest.findAll({ include: [Candidate], order: [['updatedAt', 'DESC']] }),
    CandidateOnboardingDocument.findAll({ include: [Candidate], order: [['updatedAt', 'DESC']] }),
    ExtensionRequest.findAll({ include: [Employee], order: [['updatedAt', 'DESC']] }),
    ProjectAssignment.findAll({ include: [Employee], order: [['updatedAt', 'DESC']] }),
    SprintBoard.findAll({ include: [Employee], order: [['updatedAt', 'DESC']] }),
    WorkTask.findAll({ include: [Employee, SprintBoard], order: [['updatedAt', 'DESC']] }),
    Certification.findAll({ include: [Employee], order: [['updatedAt', 'DESC']] }),
    AuditLog.findAll({ order: [['createdAt', 'DESC']], limit: 50 })
  ]);
  res.json({ jds, candidates, panelists, interviews, offers, employees, mails, learningCourses, learningAttempts, departments, masterRecords, candidateTests, candidateOnboardingDocuments, extensionRequests, projectAssignments, sprintBoards, workTasks, certifications, auditLogs, integrations: { teams: teamsIntegrationStatus(), email: { mode: process.env.MAIL_MODE || 'queue', host: process.env.MAIL_HOST || process.env.SMTP_HOST || 'smtp.office365.com', from: process.env.MAIL_FROM || process.env.MAIL_USER || process.env.SMTP_USER || '' } } });
}));

app.get('/api/employee-portal/bootstrap', asyncRoute(async (req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const claims = verifyPortalToken(token);
  if (!claims) return res.status(401).json({ message: 'Employee session expired. Please login again.' });
  const user = await User.findOne({ where: { id: claims.id, email: claims.email } });
  if (!user || user.status !== 'Active' || !['user', 'both'].includes(user.portalAccess)) {
    return res.status(403).json({ message: 'Employee portal access is not active for this user.' });
  }
  const employee = await Employee.findOne({
    where: { [Op.or]: [{ id: user.EmployeeId || 0 }, { email: user.email }] },
    include: [OnboardingTask, BgvCheck, PayrollRun, LeaveRequest, ExpenseClaim, RelievingCase, AttendanceRecord, PerformanceReview, GeneratedLetter, FinalSettlement, Notification, LearningPath, ExtensionRequest, ProjectAssignment, SprintBoard, WorkTask, Certification]
  });
  if (!employee) return res.status(404).json({ message: 'No employee profile is linked to this login.' });
  res.json({ employee });
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
      mustChangePassword: user.mustChangePassword,
      portalToken: signPortalToken(user)
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
app.patch('/api/jds/:id', asyncRoute(async (req, res) => {
  const jd = await JobDescription.findByPk(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  res.json(await jd.update(req.body));
}));
app.delete('/api/jds/:id', asyncRoute(async (req, res) => {
  const jd = await JobDescription.findByPk(req.params.id);
  if (!jd) return res.status(404).json({ message: 'Job description not found' });
  await Candidate.update({ JobDescriptionId: null }, { where: { JobDescriptionId: jd.id } });
  await jd.destroy();
  res.json({ message: 'Job posting deleted.' });
}));
app.post('/api/departments', asyncRoute(async (req, res) => {
  if (!req.body.name) return res.status(400).json({ message: 'Department name is required.' });
  res.status(201).json(await Department.create(req.body));
}));
app.patch('/api/departments/:id', asyncRoute(async (req, res) => {
  const department = await Department.findByPk(req.params.id);
  if (!department) return res.status(404).json({ message: 'Department not found.' });
  res.json(await department.update(req.body));
}));
app.delete('/api/departments/:id', asyncRoute(async (req, res) => {
  const department = await Department.findByPk(req.params.id);
  if (!department) return res.status(404).json({ message: 'Department not found.' });
  await department.destroy();
  res.json({ message: 'Department deleted.' });
}));
app.post('/api/master-records', asyncRoute(async (req, res) => {
  if (!req.body.module || !req.body.name) return res.status(400).json({ message: 'Module and name are required.' });
  res.status(201).json(await MasterRecord.create(req.body));
}));
app.patch('/api/master-records/:id', asyncRoute(async (req, res) => {
  const record = await MasterRecord.findByPk(req.params.id);
  if (!record) return res.status(404).json({ message: 'Record not found.' });
  res.json(await record.update(req.body));
}));
app.delete('/api/master-records/:id', asyncRoute(async (req, res) => {
  const record = await MasterRecord.findByPk(req.params.id);
  if (!record) return res.status(404).json({ message: 'Record not found.' });
  await record.destroy();
  res.json({ message: 'Record deleted.' });
}));
app.post('/api/upload', upload.single('resume'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.originalname });
}));
app.post('/api/candidates', asyncRoute(async (req, res) => res.status(201).json(await Candidate.create(req.body))));
app.patch('/api/candidates/:id', asyncRoute(async (req, res) => {
  const candidate = await Candidate.findByPk(req.params.id);
  if (!candidate) return res.status(404).json({ message: 'Candidate not found' });
  res.json(await candidate.update(req.body));
}));
app.post('/api/candidates/:id/action', asyncRoute(async (req, res) => {
  const candidate = await Candidate.findByPk(req.params.id, { include: [JobDescription] });
  if (!candidate) return res.status(404).json({ message: 'Candidate not found' });
  const action = req.body.action;
  if (action === 'test') {
    const questions = generateCandidateQuestions(candidate, candidate.JobDescription);
    const test = await CandidateTest.create({
      CandidateId: candidate.id,
      title: `${candidate.roleApplied || candidate.JobDescription?.title || 'Candidate'} AI Assessment`,
      questions,
      status: 'Sent',
      sentAt: new Date(),
      durationMinutes: Number(req.body.durationMinutes || 45)
    });
    const testUrl = `${process.env.CANDIDATE_PORTAL_URL || process.env.ADMIN_PORTAL_URL || 'http://localhost:5173'}/candidate-test/${test.id}`;
    await candidate.update({ status: 'Test Link Sent' });
    await queueMail({
      to: candidate.email,
      kind: 'Test Invitation',
      subject: `AI assessment link: ${test.title}`,
      html: `<p>Dear ${candidate.name},</p><p>Please complete your AI generated assessment here: <a href="${testUrl}">${testUrl}</a>.</p><p>Temporary candidate access only includes Dashboard and Take Test.</p>`
    });
    await writeAudit({ action: 'Generated candidate assessment from workflow action', entityType: 'CandidateTest', entityId: test.id, details: { candidateId: candidate.id } });
    return res.json({ candidate, test, message: 'Test Link Sent mail processed.' });
  }
  const onboardingUrl = candidateOnboardingUrl(candidate);
  const links = {
    test: `${process.env.ADMIN_PORTAL_URL || 'http://localhost:5173'}/candidate-test/${candidate.id}`,
    documents: onboardingUrl,
    onboarding: onboardingUrl
  };
  const map = {
    test: {
      status: 'Test Link Sent',
      subject: `Assessment link for ${candidate.roleApplied || candidate.JobDescription?.title || 'your application'}`,
      html: `<p>Dear ${candidate.name},</p><p>Please complete your pre-interview assessment using this secure link:</p><p><a href="${links.test}">${links.test}</a></p>`
    },
    interview: {
      status: 'Approved for Interview',
      subject: `Approved for interview - ${candidate.roleApplied || candidate.JobDescription?.title || 'Role'}`,
      html: `<p>Dear ${candidate.name},</p><p>You have been approved for the interview stage. HR will share the interview schedule shortly.</p>`
    },
    documents: {
      status: 'Document Upload Requested',
      subject: 'Document upload requested',
      html: `<p>Dear ${candidate.name},</p><p>Please upload your documents for HR review using this link:</p><p><a href="${links.documents}">${links.documents}</a></p>`
    },
    onboarding: {
      status: 'Approved for Onboarding',
      subject: 'Approved for onboarding',
      html: `<p>Dear ${candidate.name},</p><p>Your onboarding has been approved. Please continue using this link:</p><p><a href="${links.onboarding}">${links.onboarding}</a></p>`
    },
    reject: {
      status: 'Rejected',
      subject: `Application update - ${candidate.roleApplied || candidate.JobDescription?.title || 'Role'}`,
      html: `<p>Dear ${candidate.name},</p><p>Thank you for your interest. After review, we are unable to proceed with your application at this time.</p>`
    }
  };
  const config = map[action];
  if (!config) return res.status(400).json({ message: 'Invalid candidate action.' });
  let documents = [];
  if (['documents', 'onboarding'].includes(action)) {
    documents = await ensureCandidateOnboardingDocuments(candidate);
  }
  await candidate.update({ status: config.status });
  await queueMail({ to: candidate.email, kind: `Candidate ${config.status}`, subject: config.subject, html: config.html });
  await writeAudit({ action: config.status, entityType: 'Candidate', entityId: candidate.id, details: { email: candidate.email, onboardingUrl: ['documents', 'onboarding'].includes(action) ? links.onboarding : undefined, documentCount: documents.length } });
  res.json({ candidate, documents, onboardingUrl: ['documents', 'onboarding'].includes(action) ? links.onboarding : undefined, message: `${config.status} mail processed.` });
}));

app.post('/api/candidates/:id/tests/generate', asyncRoute(async (req, res) => {
  const candidate = await Candidate.findByPk(req.params.id, { include: [JobDescription] });
  if (!candidate) return res.status(404).json({ message: 'Candidate not found' });
  const questions = generateCandidateQuestions(candidate, candidate.JobDescription);
  const test = await CandidateTest.create({
    CandidateId: candidate.id,
    title: `${candidate.roleApplied || candidate.JobDescription?.title || 'Candidate'} AI Assessment`,
    questions,
    status: req.body.sendNow === false ? 'Generated' : 'Sent',
    sentAt: req.body.sendNow === false ? null : new Date(),
    durationMinutes: Number(req.body.durationMinutes || 45)
  });
  if (req.body.sendNow !== false) {
    await candidate.update({ status: 'Test Link Sent' });
    await queueMail({
      to: candidate.email,
      kind: 'Test Invitation',
      subject: `AI assessment link: ${test.title}`,
      html: `<p>Dear ${candidate.name},</p><p>Your AI generated assessment is ready. Duration: <strong>${test.durationMinutes} minutes</strong>.</p><p>Temporary candidate portal: ${process.env.CANDIDATE_PORTAL_URL || process.env.ADMIN_PORTAL_URL || 'http://localhost:5173'}/candidate-test/${test.id}</p>`
    });
  }
  await writeAudit({ action: 'Generated candidate assessment', entityType: 'CandidateTest', entityId: test.id, details: { candidateId: candidate.id, questions: questions.length } });
  res.status(201).json(test);
}));

app.post('/api/candidates/:id/send-test', asyncRoute(async (req, res) => {
  const { id } = req.params;
  const candidate = await Candidate.findByPk(id, { include: [JobDescription] });
  if (!candidate) return res.status(404).send('Candidate not found');

  const questions = generateCandidateQuestions(candidate, candidate.JobDescription);
  const test = await CandidateTest.create({
    CandidateId: candidate.id,
    title: `${candidate.roleApplied || 'Candidate'} AI Assessment`,
    questions,
    status: 'Sent',
    sentAt: new Date(),
    durationMinutes: 45,
  });

  await candidate.update({ status: 'Test Link Sent' });

  const testUrl = `${process.env.CANDIDATE_PORTAL_URL || process.env.ADMIN_PORTAL_URL || 'http://localhost:5173'}/candidate-test/${test.id}`;
  await queueMail({
    to: candidate.email,
    kind: 'Test Invitation',
    subject: `AI assessment link: ${test.title}`,
    html: `<p>Dear ${candidate.name},</p><p>Your assessment is ready. You can access it here: <a href="${testUrl}">${testUrl}</a></p><p>Temporary candidate access only includes Dashboard and Take Test.</p>`,
  });

  await writeAudit({ action: 'Sent candidate assessment', entityType: 'CandidateTest', entityId: test.id, details: { candidateId: candidate.id, candidateName: candidate.name } });

  res.status(201).json({ test });
}));

app.post('/api/candidates/tests/bulk-generate', asyncRoute(async (req, res) => {
  const ids = req.body.candidateIds?.length ? req.body.candidateIds : (await Candidate.findAll({ attributes: ['id'] })).map((candidate) => candidate.id);
  const tests = [];
  for (const id of ids) {
    const candidate = await Candidate.findByPk(id, { include: [JobDescription] });
    if (!candidate) continue;
    const questions = generateCandidateQuestions(candidate, candidate.JobDescription);
    const test = await CandidateTest.create({ CandidateId: candidate.id, title: `${candidate.roleApplied || 'Candidate'} AI Assessment`, questions, status: 'Sent', sentAt: new Date(), durationMinutes: 45 });
    await candidate.update({ status: 'Test Link Sent' });
    const testUrl = `${process.env.CANDIDATE_PORTAL_URL || process.env.ADMIN_PORTAL_URL || 'http://localhost:5173'}/candidate-test/${test.id}`;
    await queueMail({ to: candidate.email, kind: 'Test Invitation', subject: `AI assessment link: ${test.title}`, html: `<p>Dear ${candidate.name}, your assessment is ready. You can access it here: <a href="${testUrl}">${testUrl}</a>.</p><p>Temporary candidate access only includes Dashboard and Take Test.</p>` });
    tests.push(test);
  }
  await writeAudit({ action: 'Bulk generated candidate assessments', entityType: 'CandidateTest', details: { count: tests.length } });
  res.status(201).json({ tests });
}));

app.post('/api/candidate-tests/:id/submit', asyncRoute(async (req, res) => {
  const test = await CandidateTest.findByPk(req.params.id, { include: [Candidate] });
  if (!test) return res.status(404).json({ message: 'Candidate test not found' });
  const report = evaluateCandidateTest(test, req.body.answers || {});
  await test.update({ ...report, answers: req.body.answers || {}, status: 'Submitted', submittedAt: new Date() });
  await test.Candidate.update({ status: report.score >= 70 ? 'Test Passed' : 'Test Review Required', shortlistScore: report.score });
  await queueMail({
    to: process.env.MAIL_FROM || process.env.MAIL_USER || process.env.SMTP_USER || 'hr@infolinx.com',
    kind: 'Assessment Result',
    subject: `Assessment submitted: ${test.Candidate.name}`,
    html: `<p>${test.Candidate.name} submitted ${test.title}.</p><p>Score: <strong>${report.score}%</strong><br/>Recommendation: ${report.recommendation}</p>`
  });
  await writeAudit({ action: 'Submitted candidate assessment', entityType: 'CandidateTest', entityId: test.id, details: report });
  res.json(await CandidateTest.findByPk(test.id, { include: [Candidate] }));
}));
app.post('/api/panelists', asyncRoute(async (req, res) => res.status(201).json(await Panelist.create(req.body))));
app.patch('/api/panelists/:id', asyncRoute(async (req, res) => {
  const panelist = await Panelist.findByPk(req.params.id);
  if (!panelist) return res.status(404).json({ message: 'Panelist not found' });
  res.json(await panelist.update(req.body));
}));

app.get('/api/learning/:courseId/test', asyncRoute(async (req, res) => {
  const course = await LearningCourse.findByPk(req.params.courseId);
  if (!course) return res.status(404).json({ message: 'Course not found' });
  const questions = (course.questions || []).map(({ answer, ...question }) => question);
  res.json({ courseId: course.id, title: course.title, questions });
}));

app.post('/api/learning-courses', asyncRoute(async (req, res) => {
  const generated = req.body.autoGenerate === false
    ? {}
    : generatedLearningMaterial({
      title: req.body.title,
      category: req.body.category || 'Technical',
      audience: req.body.audience || 'All Employees',
      durationMinutes: Number(req.body.durationMinutes || 30)
    });
  const payload = { ...req.body, ...generated, videoUrl: null };
  validateLearningCourseInput(payload);
  const course = await LearningCourse.create({
    title: payload.title,
    category: payload.category || 'Technical',
    audience: payload.audience || 'All Employees',
    videoUrl: null,
    textContent: payload.textContent || 'Learning content created by HR Admin.',
    materialHtml: payload.materialHtml,
    pdfFileName: payload.pdfFileName,
    durationMinutes: Number(payload.durationMinutes || 30),
    status: payload.status || 'Published',
    questions: payload.questions || [
      { id: 'q1', question: `What is the main outcome of ${payload.title || 'this program'}?`, options: ['Apply the learning at work', 'Ignore the content', 'Skip assessment'], answer: 'Apply the learning at work' },
      { id: 'q2', question: 'When should doubts be raised?', options: ['During learning or review', 'Never', 'After certification only'], answer: 'During learning or review' }
    ]
  });
  await writeAudit({ action: 'Created learning course', entityType: 'LearningCourse', entityId: course.id, details: { title: course.title } });
  res.status(201).json(course);
}));

app.patch('/api/learning-courses/:id', asyncRoute(async (req, res) => {
  const course = await LearningCourse.findByPk(req.params.id);
  if (!course) return res.status(404).json({ message: 'Learning course not found' });
  const payload = { ...req.body };
  if (payload.autoGenerate) {
    Object.assign(payload, generatedLearningMaterial({
      title: payload.title || course.title,
      category: payload.category || course.category,
      audience: payload.audience || course.audience,
      durationMinutes: payload.durationMinutes || course.durationMinutes
    }));
  }
  payload.videoUrl = null;
  delete payload.autoGenerate;
  validateLearningCourseInput({ ...course.toJSON(), ...payload });
  if (payload.durationMinutes !== undefined) payload.durationMinutes = Number(payload.durationMinutes || 0);
  await course.update(payload);
  await writeAudit({ action: 'Updated learning course', entityType: 'LearningCourse', entityId: course.id, details: payload });
  res.json(course);
}));

app.post('/api/learning-courses/auto-generate', asyncRoute(async (req, res) => {
  const material = generatedLearningMaterial({
    title: req.body.title || 'Workplace Learning Program',
    category: req.body.category || 'Technical',
    audience: req.body.audience || 'All Employees',
    durationMinutes: Number(req.body.durationMinutes || 30)
  });
  res.json(material);
}));

app.post('/api/employees/:id/learning-lifecycle/generate', asyncRoute(async (req, res) => {
  const employee = await Employee.findByPk(req.params.id);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  const paths = await generateLearningLifecycle(employee);
  await queueMailOnce({
    to: employee.email,
    kind: 'Beginner Learning Ready',
    subject: 'Your Beginner Level Learning Is Ready',
    html: `<p>Dear ${employee.name},</p><p>Your Beginner Level learning module is now ready.</p><p>Please log in to the Employee Portal using your credentials and start your learning journey.</p><p>Regards,<br/>HR Team</p>`,
    entityType: 'Employee',
    entityId: employee.id
  });
  await writeAudit({ action: 'Generated skill-based learning lifecycle', entityType: 'Employee', entityId: employee.id, details: { paths: paths.length, progressStartsAt: 0 } });
  res.status(201).json(await Employee.findByPk(employee.id, { include: [LearningPath, ProjectAssignment, Certification, WorkTask] }));
}));

app.post('/api/learning-paths/:id/assessments/:testId/complete', asyncRoute(async (req, res) => {
  const path = await LearningPath.findByPk(req.params.id, { include: [Employee] });
  if (!path) return res.status(404).json({ message: 'Learning path not found' });
  const curriculum = path.curriculum || {};
  const tests = (curriculum.tests || []).map((test) => test.id === req.params.testId ? {
    ...test,
    status: Number(req.body.score || 0) >= 70 ? 'Passed' : 'Needs Retake',
    score: Number(req.body.score || 0),
    completedAt: new Date().toISOString()
  } : test);
  const passed = tests.filter((test) => test.status === 'Passed').length;
  const progress = Math.min(100, Math.round((passed / 3) * 100));
  const status = passed >= 3 ? 'Completed' : 'In Progress';
  await path.update({ curriculum: { ...curriculum, tests }, assessmentsPassed: passed, progress, status });
  if (passed >= 3) {
    const nextLevel = path.level === 'Beginner' ? 'Intermediate' : path.level === 'Intermediate' ? 'Advanced' : null;
    if (nextLevel) {
      await LearningPath.update({ status: 'In Progress', progress: 0 }, { where: { EmployeeId: path.EmployeeId, level: nextLevel, status: 'Locked' } });
    } else {
      await ProjectAssignment.findOrCreate({
        where: { EmployeeId: path.EmployeeId, title: 'Mini Project - Production Readiness' },
        defaults: {
          EmployeeId: path.EmployeeId,
          title: 'Mini Project - Production Readiness',
          description: 'Complete a 15-day mini project based on the completed Advanced learning path.',
          deliverables: 'Working demo, code/repository link, test evidence, deployment notes, and review response.',
          evaluationCriteria: 'Completeness, code quality, documentation, testing, and product thinking.',
          durationDays: 15,
          status: 'Assigned'
        }
      });
    }
  }
  await writeAudit({ action: 'Completed learning assessment', entityType: 'LearningPath', entityId: path.id, details: { testId: req.params.testId, passed, progress } });
  res.json(await LearningPath.findByPk(path.id, { include: [Employee] }));
}));

app.post('/api/employees/:id/core-allocation', asyncRoute(async (req, res) => {
  const employee = await Employee.findByPk(req.params.id);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  const [cert] = await Certification.findOrCreate({
    where: { EmployeeId: employee.id, title: 'Career Entry Completion Certificate' },
    defaults: { EmployeeId: employee.id, title: 'Career Entry Completion Certificate', level: 'Advanced', status: 'Completed', issuedAt: new Date().toISOString().slice(0, 10) }
  });
  await cert.update({ status: 'Completed', issuedAt: cert.issuedAt || new Date().toISOString().slice(0, 10) });
  const [board] = await SprintBoard.findOrCreate({
    where: { EmployeeId: employee.id, name: 'Production Core Team Sprint' },
    defaults: { EmployeeId: employee.id, name: 'Production Core Team Sprint', sprintGoal: 'Start production delivery after certification.', startDate: new Date().toISOString().slice(0, 10), endDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10) }
  });
  for (const [index, title] of ['Join project documentation', 'Pick first sprint task', 'Submit daily update', 'Attend sprint review'].entries()) {
    await WorkTask.findOrCreate({
      where: { EmployeeId: employee.id, SprintBoardId: board.id, title },
      defaults: { EmployeeId: employee.id, SprintBoardId: board.id, title, description: 'Core team allocation task.', storyPoints: index + 1, priority: index === 1 ? 'High' : 'Medium', status: index === 0 ? 'In Progress' : 'To Do' }
    });
  }
  await queueMail({ to: employee.email, kind: 'Core Team Allocation', subject: 'Core team access granted', html: `<p>Dear ${employee.name}, your certification is complete and production project access has been granted.</p>` });
  await writeAudit({ action: 'Allocated employee to core team', entityType: 'Employee', entityId: employee.id });
  res.json(await Employee.findByPk(employee.id, { include: [Certification, SprintBoard, WorkTask] }));
}));

app.post('/api/learning/:courseId/attempts', asyncRoute(async (req, res) => {
  const course = await LearningCourse.findByPk(req.params.courseId);
  if (!course) return res.status(404).json({ message: 'Course not found' });
  const answers = req.body.answers || {};
  const questions = course.questions || [];
  const autoGradable = questions.filter((question) => question.answer !== undefined && !['textarea', 'coding'].includes(question.type));
  const correct = autoGradable.filter((question) => {
    const answer = answers[question.id];
    if (Array.isArray(question.answer)) {
      const expected = [...question.answer].sort().join('|');
      const received = Array.isArray(answer) ? [...answer].sort().join('|') : String(answer || '');
      return expected === received;
    }
    return answer === question.answer;
  }).length;
  const score = autoGradable.length ? Math.round((correct / autoGradable.length) * 100) : 0;
  const attempt = await LearningAttempt.create({
    LearningCourseId: course.id,
    EmployeeId: req.body.EmployeeId,
    answers,
    score,
    status: score >= 70 ? 'Passed' : 'Needs Retake',
    completedAt: new Date()
  });
  res.status(201).json(await LearningAttempt.findByPk(attempt.id, { include: [LearningCourse, Employee] }));
}));

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

app.post('/api/employees', asyncRoute(async (req, res) => {
  const required = ['employeeCode', 'name', 'email', 'department', 'designation', 'joiningDate'];
  const missing = required.filter((field) => !req.body[field]);
  if (missing.length) return res.status(400).json({ message: `Missing required fields: ${missing.join(', ')}` });
  const employeeType = req.body.employeeType || 'New Employee';
  const isExistingEmployee = employeeType === 'Existing Employee';
  const employee = await Employee.create({
    employeeCode: req.body.employeeCode,
    name: req.body.name,
    email: req.body.email,
    department: req.body.department,
    designation: req.body.designation,
    joiningDate: req.body.joiningDate,
    manager: req.body.manager || 'HR Admin',
    salaryAnnual: Number(req.body.salaryAnnual || 0),
    status: req.body.status || 'Active',
    leaveBalance: Number(req.body.leaveBalance ?? 24)
  });
  if (!isExistingEmployee) {
    await OnboardingTask.bulkCreate(['Identity proof', 'Address proof', 'Education certificates', 'Bank details', 'Policy acknowledgement'].map((title) => ({
      title,
      category: 'Document',
      EmployeeId: employee.id,
      dueDate: employee.joiningDate,
      documentUrl: `/demo-documents/${employee.employeeCode}-${title.toLowerCase().replaceAll(' ', '-')}.pdf`
    })));
    await BgvCheck.bulkCreate(['Identity verification', 'Address verification', 'Education verification', 'Employment verification'].map((type) => ({
      type,
      vendor: 'Preferred BGV Partner',
      EmployeeId: employee.id
    })));
  }
  if (req.body.createPortalAccess !== false) await provisionPortalUser({ employee });
  res.status(201).json(employee);
}));

app.patch('/api/employees/:id', asyncRoute(async (req, res) => {
  const employee = await Employee.findByPk(req.params.id);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  const payload = {
    employeeCode: req.body.employeeCode,
    name: req.body.name,
    email: req.body.email,
    department: req.body.department,
    designation: req.body.designation,
    joiningDate: req.body.joiningDate,
    manager: req.body.manager,
    salaryAnnual: req.body.salaryAnnual !== undefined ? Number(req.body.salaryAnnual || 0) : undefined,
    status: req.body.status,
    leaveBalance: req.body.leaveBalance !== undefined ? Number(req.body.leaveBalance || 0) : undefined
  };
  Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
  await employee.update(payload);
  await User.update({ name: employee.name, email: employee.email }, { where: { EmployeeId: employee.id } });
  res.json(employee);
}));

app.delete('/api/employees/:id', asyncRoute(async (req, res) => {
  const employee = await Employee.findByPk(req.params.id);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  await Promise.all([
    OnboardingTask.destroy({ where: { EmployeeId: employee.id } }),
    BgvCheck.destroy({ where: { EmployeeId: employee.id } }),
    PayrollRun.destroy({ where: { EmployeeId: employee.id } }),
    LeaveRequest.destroy({ where: { EmployeeId: employee.id } }),
    ExpenseClaim.destroy({ where: { EmployeeId: employee.id } }),
    RelievingCase.destroy({ where: { EmployeeId: employee.id } }),
    AttendanceRecord.destroy({ where: { EmployeeId: employee.id } }),
    PerformanceReview.destroy({ where: { EmployeeId: employee.id } }),
    GeneratedLetter.destroy({ where: { EmployeeId: employee.id } }),
    FinalSettlement.destroy({ where: { EmployeeId: employee.id } }),
    LearningAttempt.destroy({ where: { EmployeeId: employee.id } }),
    Notification.destroy({ where: { EmployeeId: employee.id } }),
    User.destroy({ where: { EmployeeId: employee.id } })
  ]);
  await employee.destroy();
  res.json({ message: 'Employee deleted.' });
}));

app.post('/api/offers', asyncRoute(async (req, res) => {
  const candidate = await Candidate.findByPk(req.body.CandidateId);
  if (!candidate) return res.status(404).json({ message: 'Candidate not found' });
  const draft = Offer.build(req.body);
  draft.annualCtc = Number(draft.annualCtc || 0);
  draft.offerDate = draft.offerDate || new Date().toISOString().slice(0, 10);
  draft.salaryBreakup = calculateOfferBreakup(draft.annualCtc);
  draft.html = req.body.html || offerHtml({ candidate, offer: draft });
  const offer = await draft.save();
  await candidate.update({ status: 'Offer Generated' });
  if (req.body.sendMail !== false) {
    await queueMail({ to: candidate.email, kind: 'Offer', subject: `Offer letter: ${offer.designation}`, html: offer.html });
  }
  await writeAudit({ action: 'Generated offer letter', entityType: 'Offer', entityId: offer.id, details: { candidateId: candidate.id, annualCtc: offer.annualCtc } });
  res.status(201).json(await Offer.findByPk(offer.id, { include: [Candidate] }));
}));

app.patch('/api/offers/:id', asyncRoute(async (req, res) => {
  const offer = await Offer.findByPk(req.params.id, { include: [Candidate] });
  if (!offer) return res.status(404).json({ message: 'Offer not found' });
  const payload = { ...req.body };
  if (payload.annualCtc !== undefined) payload.annualCtc = Number(payload.annualCtc || 0);
  if (payload.annualCtc !== undefined) payload.salaryBreakup = calculateOfferBreakup(payload.annualCtc);
  if (req.body.regenerateHtml) payload.html = offerHtml({ candidate: offer.Candidate, offer: { ...offer.toJSON(), ...payload } });
  await offer.update(payload);
  if (payload.status === 'Sent') {
    await queueMail({ to: offer.Candidate.email, kind: 'Offer Letter', subject: `Offer letter: ${offer.designation}`, html: offer.html });
  }
  await writeAudit({ action: 'Updated offer letter', entityType: 'Offer', entityId: offer.id, details: payload });
  res.json(await Offer.findByPk(offer.id, { include: [Candidate] }));
}));

app.post('/api/offers/:id/dispatch', asyncRoute(async (req, res) => {
  const offer = await Offer.findByPk(req.params.id, { include: [Candidate] });
  if (!offer) return res.status(404).json({ message: 'Offer not found' });
  let html = offer.html;
  if (!html || req.body.regenerateHtml) {
    html = offerHtml({ candidate: offer.Candidate, offer });
    await offer.update({ html, salaryBreakup: calculateOfferBreakup(offer.annualCtc) });
  }
  const documentHtml = offerDocumentHtml({ ...offer.toJSON(), html });
  const fileBase = `Infolinx-Offer-${String(offer.Candidate.name || 'Candidate').replace(/[^a-z0-9]+/gi, '-')}`;
  const mail = await queueMail({
    to: offer.Candidate.email,
    kind: 'Offer Letter Dispatch',
    subject: `Offer of Appointment - ${offer.designation || offer.Candidate.roleApplied || 'Infolinx'}`,
    html: offerDispatchEmailHtml({ candidate: offer.Candidate, offer }),
    attachments: [{
      filename: `${fileBase}.doc`,
      content: Buffer.from(documentHtml, 'utf8').toString('base64'),
      encoding: 'base64',
      contentType: 'application/msword'
    }]
  });
  await offer.update({ status: mail.status === 'Failed' ? 'Dispatch Failed' : 'Sent' });
  await writeAudit({ action: 'Dispatched offer letter', entityType: 'Offer', entityId: offer.id, details: { candidateId: offer.Candidate.id, mailId: mail.id, status: mail.status } });
  res.json({ offer: await Offer.findByPk(offer.id, { include: [Candidate] }), mail });
}));

app.post('/api/offers/:id/accept', asyncRoute(async (req, res) => {
  const offer = await Offer.findByPk(req.params.id, { include: [Candidate] });
  if (!offer) return res.status(404).json({ message: 'Offer not found' });
  await offer.update({ status: 'Accepted' });
  const employeeCode = await nextEmployeeCode();
  const officialEmail = await officialEmailFor(offer.Candidate.name);
  const employee = await Employee.create({
    employeeCode,
    name: offer.Candidate.name,
    email: officialEmail,
    designation: offer.designation,
    department: req.body.department || 'Product Engineering',
    joiningDate: offer.joiningDate,
    manager: req.body.manager || 'Hiring Manager',
    salaryAnnual: offer.annualCtc,
    CandidateId: offer.Candidate.id
  });
  const tasks = ['Aadhaar', 'PAN', 'Educational Certificates', 'Experience Letters', 'Resume', 'Passport Photo', 'Address Proof', 'Signed Offer Letter'];
  await OnboardingTask.bulkCreate(tasks.map((title) => ({
    title,
    category: 'Document',
    EmployeeId: employee.id,
    dueDate: offer.joiningDate,
    documentUrl: `/demo-documents/${employee.employeeCode}-${title.toLowerCase().replaceAll(' ', '-')}.pdf`
  })));
  await BgvCheck.bulkCreate(['Education', 'Employment', 'Identity', 'Address'].map((type) => ({ type, vendor: 'Preferred BGV Partner', status: 'Pending', EmployeeId: employee.id })));
  await offer.Candidate.update({ status: 'Onboarding' });
  const access = await provisionPortalUser({ employee });
  await queueMail({
    to: offer.Candidate.email,
    kind: 'Onboarding Approval',
    subject: `Welcome to Infolinx - ${employee.employeeCode}`,
    html: `<p>Dear ${offer.Candidate.name},</p><p>Your onboarding is approved.</p><p>Employee ID: <strong>${employee.employeeCode}</strong><br/>Official email: <strong>${employee.email}</strong>${access.password ? `<br/>First-time password: <strong>${access.password}</strong>` : ''}</p><p>Your temporary candidate access is closed. Please use the employee portal now.</p>`
  });
  await ensureLifecycleDemoData();
  await writeAudit({ action: 'Accepted offer and generated employee record', entityType: 'Employee', entityId: employee.id, details: { candidateId: offer.Candidate.id, employeeCode, officialEmail } });
  res.status(201).json(employee);
}));

app.get('/api/candidate-onboarding/:token', asyncRoute(async (req, res) => {
  const claims = verifySignedToken(req.params.token, 'candidate-onboarding');
  if (!claims) return res.status(401).json({ message: 'Candidate onboarding link is invalid or expired.' });
  const candidate = await Candidate.findByPk(claims.id, { include: [JobDescription, Offer, CandidateOnboardingDocument] });
  if (!candidate || candidate.email !== claims.email) return res.status(404).json({ message: 'Candidate onboarding record not found.' });
  const documents = await ensureCandidateOnboardingDocuments(candidate);
  const fresh = await CandidateOnboardingDocument.findAll({ where: { CandidateId: candidate.id }, order: [['id', 'ASC']] });
  res.json({
    candidate: {
      id: candidate.id,
      name: candidate.name,
      email: candidate.email,
      roleApplied: candidate.roleApplied || candidate.JobDescription?.title || '',
      status: candidate.status,
      offerStatus: candidate.Offer?.status || ''
    },
    documents: fresh.length ? fresh : documents,
    expiresAt: new Date(claims.exp).toISOString()
  });
}));

app.post('/api/candidate-onboarding/:token/documents/:id', upload.single('document'), asyncRoute(async (req, res) => {
  const claims = verifySignedToken(req.params.token, 'candidate-onboarding');
  if (!claims) return res.status(401).json({ message: 'Candidate onboarding link is invalid or expired.' });
  const document = await CandidateOnboardingDocument.findByPk(req.params.id, { include: [Candidate] });
  if (!document || document.CandidateId !== claims.id || document.Candidate?.email !== claims.email) {
    return res.status(404).json({ message: 'Document checklist item not found for this candidate.' });
  }
  if (!req.file) return res.status(400).json({ message: 'Please choose a document to upload.' });
  const updated = await document.update({
    status: 'Submitted',
    documentUrl: `/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    contentType: req.file.mimetype,
    size: req.file.size,
    remarks: req.body.remarks || 'Submitted from temporary candidate onboarding page',
    submittedAt: new Date()
  });
  await writeAudit({ action: 'Candidate uploaded onboarding document', entityType: 'CandidateOnboardingDocument', entityId: updated.id, details: { candidateId: claims.id, title: updated.title, filename: updated.filename } });
  res.json(updated);
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

app.post('/api/attendance/clock-in', asyncRoute(async (req, res) => {
  const employee = await Employee.findByPk(req.body.EmployeeId);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const time = req.body.time || new Date().toTimeString().slice(0, 5);
  const [record] = await AttendanceRecord.findOrCreate({
    where: { EmployeeId: employee.id, date },
    defaults: {
      EmployeeId: employee.id,
      date,
      checkIn: time,
      clockInLocation: req.body.location || 'Office',
      workMode: req.body.workMode || 'Office',
      remarks: req.body.remarks || 'Clocked in from HRMS',
      status: 'Present'
    }
  });
  if (record.checkOut) return res.status(400).json({ message: 'Attendance already completed for this date.' });
  await record.update({
    checkIn: record.checkIn || time,
    clockInLocation: req.body.location || record.clockInLocation || 'Office',
    workMode: req.body.workMode || record.workMode || 'Office',
    remarks: req.body.remarks || record.remarks,
    status: 'Present'
  });
  res.status(201).json(record);
}));

app.post('/api/attendance/clock-out', asyncRoute(async (req, res) => {
  const employee = await Employee.findByPk(req.body.EmployeeId);
  if (!employee) return res.status(404).json({ message: 'Employee not found' });
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const record = await AttendanceRecord.findOne({ where: { EmployeeId: employee.id, date } });
  if (!record || !record.checkIn) return res.status(400).json({ message: 'Clock in first before clock out.' });
  if (record.checkOut) return res.status(400).json({ message: 'Clock out already recorded for this date.' });
  const time = req.body.time || new Date().toTimeString().slice(0, 5);
  const totalHours = calculateHours(record.checkIn, time);
  await record.update({
    checkOut: time,
    totalHours,
    clockOutLocation: req.body.location || record.clockInLocation || 'Office',
    remarks: req.body.remarks || record.remarks,
    status: totalHours >= 4 && totalHours < 8 ? 'Half Day' : 'Present',
    overtimeHours: Math.max(0, Number((totalHours - 8).toFixed(2)))
  });
  res.json(record);
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

app.post('/api/extension-requests', asyncRoute(async (req, res) => {
  const request = await ExtensionRequest.create(req.body);
  await writeAudit({ action: 'Created extension request', entityType: 'ExtensionRequest', entityId: request.id, details: req.body, actor: req.body.actor || 'Employee' });
  res.status(201).json(request);
}));

app.patch('/api/extension-requests/:id', asyncRoute(async (req, res) => {
  const request = await ExtensionRequest.findByPk(req.params.id, { include: [Employee] });
  if (!request) return res.status(404).json({ message: 'Extension request not found' });
  await request.update(req.body);
  if (request.Employee?.email && ['Approved', 'Rejected'].includes(req.body.status)) {
    await queueMail({
      to: request.Employee.email,
      kind: 'Extension Decision',
      subject: `${request.requestType} ${req.body.status}`,
      html: `<p>Dear ${request.Employee.name}, your ${request.requestType} request was <strong>${req.body.status}</strong>.</p><p>${req.body.adminRemarks || ''}</p>`
    });
  }
  await writeAudit({ action: `Extension ${req.body.status || 'updated'}`, entityType: 'ExtensionRequest', entityId: request.id, details: req.body });
  res.json(request);
}));

app.patch('/api/projects/:id', asyncRoute(async (req, res) => {
  const project = await ProjectAssignment.findByPk(req.params.id, { include: [Employee] });
  if (!project) return res.status(404).json({ message: 'Project assignment not found' });
  await project.update(req.body);
  if (project.Employee?.email && req.body.status) {
    await queueMail({ to: project.Employee.email, kind: 'Project Assignment', subject: `Project status: ${project.title}`, html: `<p>${project.title} is now <strong>${req.body.status}</strong>.</p>` });
  }
  await writeAudit({ action: 'Updated project assignment', entityType: 'ProjectAssignment', entityId: project.id, details: req.body });
  res.json(project);
}));

app.patch('/api/work-tasks/:id', asyncRoute(async (req, res) => {
  const task = await WorkTask.findByPk(req.params.id);
  if (!task) return res.status(404).json({ message: 'Task not found' });
  await task.update(req.body);
  await writeAudit({ action: 'Updated sprint task', entityType: 'WorkTask', entityId: task.id, details: req.body });
  res.json(task);
}));

app.patch('/api/certifications/:id', asyncRoute(async (req, res) => {
  const certification = await Certification.findByPk(req.params.id, { include: [Employee] });
  if (!certification) return res.status(404).json({ message: 'Certification not found' });
  await certification.update({ ...req.body, issuedAt: req.body.status === 'Completed' ? new Date().toISOString().slice(0, 10) : certification.issuedAt });
  if (certification.Employee?.email && req.body.status === 'Completed') {
    await queueMail({ to: certification.Employee.email, kind: 'Certification Completion', subject: `Certification completed: ${certification.title}`, html: `<p>Congratulations ${certification.Employee.name}, your ${certification.title} certification is complete.</p>` });
  }
  await writeAudit({ action: 'Updated certification', entityType: 'Certification', entityId: certification.id, details: req.body });
  res.json(certification);
}));

app.post('/api/mail/:id/retry', asyncRoute(async (req, res) => {
  const mail = await MailLog.findByPk(req.params.id);
  if (!mail) return res.status(404).json({ message: 'Mail log not found' });
  const retry = await queueMail({ to: mail.to, subject: mail.subject, html: mail.html, kind: `${mail.kind || 'Mail'} Retry` });
  await writeAudit({ action: 'Retried email delivery', entityType: 'MailLog', entityId: mail.id, details: { retryId: retry.id } });
  if (retry.status === 'Failed') return res.status(502).json({ message: 'Email retry failed.', mail: retry, lastError: retry.lastError });
  res.json(retry);
}));

app.get('/api/mail/status', asyncRoute(async (_req, res) => {
  const mode = process.env.MAIL_MODE || 'queue';
  const config = {
    mode,
    smtp: {
      configured: Boolean((process.env.MAIL_USER || process.env.SMTP_USER) && (process.env.MAIL_PASSWORD || process.env.SMTP_PASS)),
      host: process.env.MAIL_HOST || process.env.SMTP_HOST || 'smtp.office365.com',
      port: Number(process.env.MAIL_PORT || process.env.SMTP_PORT || 587),
      user: process.env.MAIL_USER || process.env.SMTP_USER || ''
    },
    graph: {
      configured: Boolean(process.env.MS_GRAPH_TENANT_ID && process.env.MS_GRAPH_CLIENT_ID && process.env.MS_GRAPH_CLIENT_SECRET && (process.env.MS_GRAPH_MAIL_USER_ID || process.env.MS_GRAPH_USER_ID)),
      sender: process.env.MS_GRAPH_MAIL_USER_ID || process.env.MS_GRAPH_USER_ID || ''
    }
  };
  if (mode === 'smtp' && mailTransporter) {
    try {
      await mailTransporter.verify();
      return res.json({ ...config, ok: true, message: 'SMTP connection and authentication succeeded.' });
    } catch (error) {
      return res.status(502).json({ ...config, ok: false, message: error.message });
    }
  }
  if (mode === 'graph') {
    try {
      const token = await getGraphToken();
      const claims = decodeJwtPayload(token);
      const roles = claims.roles || [];
      const scopes = String(claims.scp || '').split(' ').filter(Boolean);
      const hasMailSend = roles.includes('Mail.Send') || scopes.includes('Mail.Send');
      const hasMailRead = roles.includes('Mail.Read') || scopes.includes('Mail.Read');
      if (!hasMailSend) {
        return res.status(502).json({
          ...config,
          ok: false,
          graphRoles: roles,
          graphScopes: scopes,
          message: 'Microsoft Graph token succeeded, but it does not contain Mail.Send. Add Microsoft Graph Application permission Mail.Send and grant admin consent.'
        });
      }
      return res.json({ ...config, ok: true, graphRoles: roles, graphScopes: scopes, canSend: hasMailSend, canReadInbox: hasMailRead, message: hasMailRead ? 'Microsoft Graph token succeeded and contains Mail.Send + Mail.Read.' : 'Microsoft Graph token succeeded and contains Mail.Send. Add Mail.Read application permission for inbound inbox sync.' });
    } catch (error) {
      return res.status(502).json({ ...config, ok: false, message: error.message });
    }
  }
  res.json({ ...config, ok: mode === 'queue', message: mode === 'queue' ? 'Email is queued only; no live sender configured.' : 'Unknown mail mode.' });
}));

app.post('/api/mail/inbox/sync', asyncRoute(async (_req, res) => {
  if (process.env.MAIL_MODE !== 'graph') {
    return res.status(400).json({ message: 'Inbox sync requires MAIL_MODE=graph.' });
  }
  const result = await syncGraphInbox({ limit: 25 });
  await writeAudit({ action: 'Synced Microsoft Graph inbox', entityType: 'MailLog', details: result });
  res.json(result);
}));

app.post('/api/mail/send', asyncRoute(async (req, res) => {
  const { to, subject, body, from, attachments = [] } = req.body;
  const configuredSender = process.env.MAIL_FROM || process.env.MS_GRAPH_MAIL_USER_ID || process.env.MS_GRAPH_USER_ID || process.env.MAIL_USER || process.env.SMTP_USER;
  if (!configuredSender) return res.status(500).json({ message: 'Mail sender is not configured. Set MAIL_FROM or MS_GRAPH_MAIL_USER_ID.' });
  const sender = String(from || configuredSender).trim();
  if (!subject || !body) return res.status(400).json({ message: 'Subject and mail body are required.' });

  const employees = await Employee.findAll({ where: { status: { [Op.ne]: 'Relieved' } } });
  const employeeEmails = employees.map((employee) => employee.email).filter(Boolean);
  const senderEmail = (sender.match(/<([^>]+)>/)?.[1] || sender).toLowerCase();
  const senderUser = await User.findOne({ where: { email: { [Op.iLike]: senderEmail }, status: 'Active' } });
  const adminEmails = unique([
    process.env.HR_ADMIN_EMAIL,
    process.env.MAIL_FROM,
    process.env.MS_GRAPH_MAIL_USER_ID,
    process.env.MS_GRAPH_USER_ID,
    process.env.MAIL_USER,
    process.env.SMTP_USER
  ].filter(Boolean).map((email) => email.toLowerCase()));
  const senderIsAdmin = adminEmails.includes(senderEmail) || /admin/i.test(senderUser?.role || '');
  const senderIsInfolinxUser = senderEmail.endsWith('@infolinx.com') && !!senderUser;
  if (!senderIsAdmin && !senderIsInfolinxUser) {
    return res.status(403).json({ message: 'Only admins and active @infolinx.com users can use Inbox.' });
  }

  const adminRecipient = process.env.HR_ADMIN_EMAIL || configuredSender;
  const requestedRecipients = String(to || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const recipients = String(to) === 'HR_ADMIN'
    ? [adminRecipient]
    : String(to) === 'ALL_EMPLOYEES'
      ? employeeEmails
      : senderIsAdmin
        ? requestedRecipients.filter((email) => emailPattern.test(email))
        : employeeEmails.filter((email) => email.toLowerCase() === String(to || '').toLowerCase());

  if (!recipients.length) {
    return res.status(400).json({ message: senderIsAdmin ? 'Enter a valid email address, HR Admin, or All Employees.' : 'Recipient must be HR Admin or an active organization employee.' });
  }

  const safeAttachments = attachments.slice(0, 5).map((attachment) => ({
    filename: String(attachment.filename || 'attachment').slice(0, 160),
    content: attachment.content,
    encoding: attachment.encoding || 'base64',
    contentType: attachment.contentType || 'application/octet-stream',
    size: attachment.size
  }));

  const mail = await queueMail({
    to: recipients,
    from: sender,
    kind: String(to) === 'ALL_EMPLOYEES' ? 'Outbound Broadcast' : 'Outbound Message',
    subject,
    html: `<p>${String(body).replace(/\n/g, '<br/>')}</p>`,
    attachments: safeAttachments
  });
  await writeAudit({ action: 'Sent inbox message', entityType: 'MailLog', entityId: mail.id, details: { from: sender, to: recipients, attachmentCount: safeAttachments.length } });
  if (mail.status === 'Failed') {
    return res.status(502).json({ message: 'Email delivery failed.', mail, lastError: mail.lastError });
  }
  res.status(201).json(mail);
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

if (adminPortalDistDir) {
  app.use(express.static(adminPortalDistDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(adminPortalDistDir, 'index.html'));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.statusCode || 500).json({ message: err.message || 'Server error' });
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
