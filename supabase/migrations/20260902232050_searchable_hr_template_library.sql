begin;

-- Publish the approved HR form index as searchable metadata without releasing
-- unscanned binaries or weakening the existing protected document pipeline.
create temporary table hr_template_library_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) employee_count,
  (select count(*) from public.employee_access_roles) employee_role_count,
  (select count(*) from public.access_role_permissions) role_permission_count,
  (select count(*) from public.employee_permission_overrides) override_count,
  (select count(*) from private.hr_documents) document_count,
  (select count(*) from private.hr_document_versions) document_version_count;

create table private.hr_template_library_release_gate (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  library_version text not null,
  source_reference text not null,
  released_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_template_library_version_present check (btrim(library_version) <> ''),
  constraint hr_template_library_source_present check (btrim(source_reference) <> ''),
  constraint hr_template_library_release_consistent check (
    (enabled and released_at is not null) or (not enabled and released_at is null)
  )
);

create table private.hr_template_library_items (
  id uuid primary key default gen_random_uuid(),
  organization_code text not null default 'GUARDIANSHIP',
  form_code text not null unique,
  title text not null,
  category text not null,
  record_class text not null,
  purpose text not null,
  audience_scope text not null,
  sensitivity text not null,
  source_filename text not null,
  search_aliases text[] not null default '{}'::text[],
  display_order integer not null,
  source_document_id uuid references private.hr_documents(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  search_vector tsvector not null default ''::tsvector,
  constraint hr_template_library_code_format check (form_code ~ '^GS-HR-[0-9]{3}$'),
  constraint hr_template_library_title_present check (btrim(title) <> ''),
  constraint hr_template_library_category_present check (btrim(category) <> ''),
  constraint hr_template_library_record_class_present check (btrim(record_class) <> ''),
  constraint hr_template_library_purpose_present check (btrim(purpose) <> ''),
  constraint hr_template_library_audience_scope check (audience_scope in ('all_employees','supervisors_and_hr','hr_only')),
  constraint hr_template_library_sensitivity check (sensitivity in ('standard','restricted','highly_restricted')),
  constraint hr_template_library_source_filename_present check (btrim(source_filename) <> ''),
  constraint hr_template_library_display_order_positive check (display_order > 0)
);

create index hr_template_library_active_order_idx
  on private.hr_template_library_items(active, display_order, form_code);
create index hr_template_library_category_idx
  on private.hr_template_library_items(category, display_order)
  where active;
create index hr_template_library_search_idx
  on private.hr_template_library_items using gin(search_vector);

create function private.refresh_hr_template_library_search_vector()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_vector := to_tsvector(
    'english'::regconfig,
    coalesce(new.form_code, '') || ' ' || coalesce(new.title, '') || ' ' ||
    coalesce(new.category, '') || ' ' || coalesce(new.record_class, '') || ' ' ||
    coalesce(new.purpose, '') || ' ' || coalesce(array_to_string(new.search_aliases, ' '), '')
  );
  return new;
end
$$;

alter table private.hr_template_library_release_gate enable row level security;
alter table private.hr_template_library_items enable row level security;
revoke all on private.hr_template_library_release_gate from public, anon, authenticated;
revoke all on private.hr_template_library_items from public, anon, authenticated;

create trigger hr_template_library_release_gate_updated_at
before update on private.hr_template_library_release_gate
for each row execute function private.set_updated_at();
create trigger hr_template_library_items_updated_at
before update on private.hr_template_library_items
for each row execute function private.set_updated_at();
create trigger hr_template_library_items_search_vector
before insert or update of form_code, title, category, record_class, purpose, search_aliases
on private.hr_template_library_items
for each row execute function private.refresh_hr_template_library_search_vector();
create trigger hr_template_library_release_gate_audit
after insert or update or delete on private.hr_template_library_release_gate
for each row execute function private.write_audit_event();
create trigger hr_template_library_items_audit
after insert or update or delete on private.hr_template_library_items
for each row execute function private.write_audit_event();

insert into private.hr_template_library_release_gate(
  singleton, enabled, library_version, source_reference, released_at
) values (
  true,
  true,
  '1.0',
  'Guardianship HR Template Library v1.0 and GS-HR Template Register',
  clock_timestamp()
);

insert into private.hr_template_library_items(
  form_code, title, category, record_class, purpose, audience_scope,
  sensitivity, source_filename, search_aliases, display_order
) values
  ('GS-HR-000', 'HR Forms Library Index, Control, and Filing Guide', 'HR Governance & Document Control', 'HR Governance / Controlled Forms Library', 'Serves as the authoritative directory and control guide for Guardianship Security LLC HR documents, including form selection, record classification, restricted-file routing, approval requirements, and revision governance.', 'hr_only', 'standard', 'GS-HR-000_HR_Forms_Library_Index_Control_and_Filing_Guide.docx', '{}'::text[], 10),
  ('GS-HR-001', 'Master Blank HR Form Template', 'HR Governance & Document Control', 'HR Governance / Controlled Forms Library', 'Provides the controlled starting point for any future Guardianship Security HR form so new documents follow the same branding, controls, record-handling rules, and approval structure.', 'hr_only', 'standard', 'GS-HR-001_Master_Blank_HR_Form_Template.docx', '{}'::text[], 20),
  ('GS-HR-002', 'Official Forms and Compliance Attachment Checklist', 'HR Governance & Document Control', 'HR Governance / Compliance Reference', 'Prevents an internal Guardianship template from being mistaken for an official government, benefit-plan, screening, insurance, or carrier form. It provides a routing checklist for documents that must be obtained from the current issuing authority.', 'hr_only', 'standard', 'GS-HR-002_Official_Forms_and_Compliance_Attachment_Checklist.docx', array['I-9','W-4','tax forms','FCRA','government forms']::text[], 30),
  ('GS-HR-100', 'Position Requisition and Hiring Authorization', 'Recruiting & Onboarding', 'Recruiting / Position Authorization', 'Documents the business need, budget, employment terms, minimum qualifications, licensing requirements, and approval to recruit or replace a position.', 'hr_only', 'standard', 'GS-HR-100_Position_Requisition_and_Hiring_Authorization.docx', '{}'::text[], 40),
  ('GS-HR-101', 'Candidate Interview Evaluation', 'Recruiting & Onboarding', 'Recruiting / Candidate Selection Record', 'Creates a consistent, job-related evaluation record for each candidate and supports defensible selection decisions based on approved criteria rather than personal impressions.', 'hr_only', 'standard', 'GS-HR-101_Candidate_Interview_Evaluation.docx', '{}'::text[], 50),
  ('GS-HR-102', 'Conditional Employment Offer Letter', 'Recruiting & Onboarding', 'Recruiting / Offer and Acceptance', 'Provides a consistent written conditional offer that identifies the position, compensation, schedule expectations, contingencies, at-will language where lawful, and acceptance deadline without promising guaranteed hours or continued employment.', 'hr_only', 'standard', 'GS-HR-102_Conditional_Employment_Offer_Letter.docx', '{}'::text[], 60),
  ('GS-HR-103', 'Pre-Employment Screening and Hiring File Checklist', 'Recruiting & Onboarding', 'Recruiting / Restricted Hiring Administration', 'Tracks completion of the approved hiring sequence while keeping screening details, medical information, and official forms in their proper restricted files.', 'hr_only', 'highly_restricted', 'GS-HR-103_Pre_Employment_Screening_and_Hiring_File_Checklist.docx', '{}'::text[], 70),
  ('GS-HR-104', 'New Hire Onboarding Checklist', 'Recruiting & Onboarding', 'Personnel File / Onboarding and Training', 'Provides a single accountable onboarding plan covering employment records, SygShift access, policy acknowledgments, licensing, training, equipment, site orientation, and supervisor follow-up.', 'supervisors_and_hr', 'standard', 'GS-HR-104_New_Hire_Onboarding_Checklist.docx', '{}'::text[], 80),
  ('GS-HR-105', 'Employee Information and Emergency Contact Record', 'Recruiting & Onboarding', 'Personnel File / Confidential Contact Information', 'Captures current contact, communication, and emergency-contact information needed for employment administration while avoiding unnecessary collection of highly sensitive data.', 'all_employees', 'restricted', 'GS-HR-105_Employee_Information_and_Emergency_Contact_Record.docx', array['emergency contact','phone number','home address','personal information']::text[], 90),
  ('GS-HR-106', 'Handbook, Policy, and Job Description Acknowledgment', 'Recruiting & Onboarding', 'Personnel File / Policy Acknowledgments', 'Documents receipt of the current employee handbook, assigned policies, job description, reporting channels, and the employee''s responsibility to ask questions and follow lawful instructions.', 'supervisors_and_hr', 'standard', 'GS-HR-106_Handbook_Policy_and_Job_Description_Acknowledgment.docx', '{}'::text[], 100),
  ('GS-HR-107', 'License, Certification, and Background Compliance Record', 'Recruiting & Onboarding', 'Credential and Qualification File / Restricted', 'Maintains an auditable record of licenses, certifications, client clearances, and recurring qualification checks required for an employee''s assignments.', 'supervisors_and_hr', 'restricted', 'GS-HR-107_License_Certification_and_Background_Compliance_Record.docx', '{}'::text[], 110),
  ('GS-HR-108', 'Training and Qualification Record', 'Recruiting & Onboarding', 'Training and Qualification File', 'Documents required and developmental training, instructor verification, competency checks, refresher deadlines, and any temporary work restriction connected to training status.', 'supervisors_and_hr', 'standard', 'GS-HR-108_Training_and_Qualification_Record.docx', '{}'::text[], 120),
  ('GS-HR-109', 'Uniform, Equipment, and Company Property Agreement', 'Recruiting & Onboarding', 'Personnel File / Property Accountability', 'Documents company property issued to an employee, condition at issue and return, employee responsibilities, approved deductions only where lawful and separately authorized, and unresolved loss or damage review.', 'supervisors_and_hr', 'standard', 'GS-HR-109_Uniform_Equipment_and_Company_Property_Agreement.docx', '{}'::text[], 130),
  ('GS-HR-200', 'Personnel Action Form', 'Employee Records & Employment Changes', 'Personnel File / Payroll and Employment Change', 'Creates the authoritative approval record for a hire, transfer, promotion, demotion, pay change, status change, supervisor change, leave status, return, or separation before systems and payroll records are updated.', 'hr_only', 'restricted', 'GS-HR-200_Personnel_Action_Form.docx', '{}'::text[], 140),
  ('GS-HR-201', 'Employee Information Change Form', 'Employee Records & Employment Changes', 'Personnel File / Confidential Contact Information', 'Provides a controlled way for an employee to update name, address, contact, emergency contact, tax-work location, or other administrative information and identifies documentation or system updates required.', 'all_employees', 'restricted', 'GS-HR-201_Employee_Information_Change_Form.docx', array['change address','new phone','name change','emergency contact']::text[], 150),
  ('GS-HR-202', 'Availability and Schedule Change Request', 'Employee Records & Employment Changes', 'Personnel File / Scheduling Administration', 'Documents an employee''s requested availability or recurring schedule change, the operational and client impact review, and the final decision without creating an automatic guarantee of hours or assignment.', 'all_employees', 'standard', 'GS-HR-202_Availability_and_Schedule_Change_Request.docx', array['availability','schedule request','change hours']::text[], 160),
  ('GS-HR-203', 'Compensation, Position, or Employment Status Change Notice', 'Employee Records & Employment Changes', 'Personnel File / Compensation and Employment Terms', 'Provides the employee a clear written notice of an approved change to pay, position, supervisor, work location, classification, employment status, or regular schedule and records receipt.', 'hr_only', 'restricted', 'GS-HR-203_Compensation_Position_or_Employment_Status_Change_Notice.docx', '{}'::text[], 170),
  ('GS-HR-204', 'Post Assignment and Post Orders Acknowledgment', 'Employee Records & Employment Changes', 'Training and Assignment File', 'Confirms that a security employee received the correct site assignment, current post orders, emergency contacts, reporting expectations, equipment requirements, and known assignment limitations before working independently.', 'supervisors_and_hr', 'standard', 'GS-HR-204_Post_Assignment_and_Post_Orders_Acknowledgment.docx', '{}'::text[], 180),
  ('GS-HR-205', 'Timekeeping and Payroll Correction Request', 'Employee Records & Employment Changes', 'Payroll / Timekeeping Adjustment Record', 'Documents a requested correction to hours, punches, site allocation, pay code, premium, leave balance, or payroll result while preserving the original record and approval trail.', 'all_employees', 'restricted', 'GS-HR-205_Timekeeping_and_Payroll_Correction_Request.docx', array['missing pay','wrong punch','payroll correction','timecard']::text[], 190),
  ('GS-HR-300', 'Supervisor Coaching and Counseling Record', 'Performance & Corrective Action', 'Supervisor Working File or Personnel File per HR Direction', 'Documents an early, constructive conversation intended to clarify expectations, provide guidance, and prevent a performance or conduct issue from becoming formal corrective action.', 'supervisors_and_hr', 'standard', 'GS-HR-300_Supervisor_Coaching_and_Counseling_Record.docx', '{}'::text[], 200),
  ('GS-HR-301', 'Corrective Action Notice', 'Performance & Corrective Action', 'Personnel File / Employee Relations', 'Provides the formal, professional record for misconduct, policy violation, attendance failure, or performance deficiency, including evidence, prior notice, employee response, required correction, support, deadlines, and consequences.', 'supervisors_and_hr', 'restricted', 'GS-HR-301_Corrective_Action_Notice.docx', '{}'::text[], 210),
  ('GS-HR-302', 'Performance Improvement Plan', 'Performance & Corrective Action', 'Personnel File / Performance Management', 'Creates a structured improvement period with measurable performance standards, resources, check-ins, evidence, and a final outcome for an employee who needs sustained performance correction.', 'supervisors_and_hr', 'standard', 'GS-HR-302_Performance_Improvement_Plan.docx', '{}'::text[], 220),
  ('GS-HR-303', 'Attendance and Reliability Review', 'Performance & Corrective Action', 'Personnel File / Attendance Management', 'Provides a consistent review of lateness, absence, call-off, no-call/no-show, shift abandonment, or pattern concerns while requiring verification of protected leave, approved time off, scheduling errors, and other excluded events.', 'supervisors_and_hr', 'standard', 'GS-HR-303_Attendance_and_Reliability_Review.docx', '{}'::text[], 230),
  ('GS-HR-304', 'Employee Response or Rebuttal Statement', 'Performance & Corrective Action', 'Personnel File or Related Restricted Case File', 'Gives an employee a consistent method to respond to coaching, corrective action, performance evaluation, investigation outcome, attendance review, or another employment record and ensures the response is associated with the original document.', 'all_employees', 'restricted', 'GS-HR-304_Employee_Response_or_Rebuttal_Statement.docx', array['response','rebuttal','dispute write-up']::text[], 240),
  ('GS-HR-305', 'Administrative Leave or Suspension Pending Investigation Notice', 'Performance & Corrective Action', 'Personnel File / Investigation Administration', 'Communicates a temporary, non-final removal from duty while facts are investigated, identifies pay and scheduling status, preserves evidence, and provides clear availability and contact expectations without presuming wrongdoing.', 'supervisors_and_hr', 'highly_restricted', 'GS-HR-305_Administrative_Leave_or_Suspension_Pending_Investigation_Notice.docx', '{}'::text[], 250),
  ('GS-HR-306', 'Employee Recognition and Commendation Record', 'Performance & Corrective Action', 'Personnel File / Recognition', 'Creates a consistent positive employment record for exceptional service, safety action, client praise, teamwork, leadership, attendance, training achievement, or process improvement.', 'supervisors_and_hr', 'standard', 'GS-HR-306_Employee_Recognition_and_Commendation_Record.docx', '{}'::text[], 260),
  ('GS-HR-400', 'Leave of Absence Request', 'Leave & Accommodation', 'Confidential Leave / Medical File - Separate from Personnel File', 'Provides a consistent internal request record for continuous or intermittent time away from work and gives HR the facts needed to evaluate all potentially applicable company, federal, state, local, benefit-plan, disability, military, jury, bereavement, safety, and accommodation processes.', 'all_employees', 'highly_restricted', 'GS-HR-400_Leave_of_Absence_Request.docx', array['PTO','vacation','leave','time off','FMLA','sick']::text[], 270),
  ('GS-HR-401', 'Leave Eligibility and Decision Cover Notice', 'Leave & Accommodation', 'Confidential Leave / Medical File - Separate from Personnel File', 'Creates Guardianship''s internal decision summary and delivery record for a leave request while requiring current official federal, state, local, benefit-plan, disability, military, or workers'' compensation notices to be attached when applicable.', 'hr_only', 'highly_restricted', 'GS-HR-401_Leave_Eligibility_and_Decision_Cover_Notice.docx', '{}'::text[], 280),
  ('GS-HR-402', 'Intermittent Leave Tracking Log', 'Leave & Accommodation', 'Confidential Leave / Medical File and Restricted Payroll Record', 'Tracks each approved intermittent or reduced-schedule leave occurrence, hours used, notification, payroll code, remaining entitlement where applicable, and follow-up without recording diagnosis or treatment details.', 'hr_only', 'highly_restricted', 'GS-HR-402_Intermittent_Leave_Tracking_Log.docx', '{}'::text[], 290),
  ('GS-HR-403', 'Return-to-Work and Work Restrictions Form', 'Leave & Accommodation', 'Confidential Medical / Accommodation File - Separate from Personnel File', 'Obtains the functional information needed to evaluate a safe return, temporary or permanent work restrictions, essential job duties, and possible accommodation without requesting an unnecessary diagnosis.', 'all_employees', 'highly_restricted', 'GS-HR-403_Return_to_Work_and_Work_Restrictions_Form.docx', array['doctor note','return to work','work restrictions']::text[], 300),
  ('GS-HR-404', 'Reasonable Accommodation Request', 'Leave & Accommodation', 'Confidential Accommodation / Medical File - Separate from Personnel File', 'Provides an accessible internal method for an applicant or employee to request a workplace change related to disability, pregnancy, childbirth, or another legally protected limitation and begins the interactive process.', 'all_employees', 'highly_restricted', 'GS-HR-404_Reasonable_Accommodation_Request.docx', array['ADA','disability','pregnancy accommodation']::text[], 310),
  ('GS-HR-405', 'Interactive Process and Accommodation Decision Record', 'Leave & Accommodation', 'Confidential Accommodation / Medical File - Separate from Personnel File', 'Documents the individualized review of essential job functions, barriers, requested and alternative accommodations, effectiveness, operational impact, implementation, follow-up, and final decision.', 'hr_only', 'highly_restricted', 'GS-HR-405_Interactive_Process_and_Accommodation_Decision_Record.docx', '{}'::text[], 320),
  ('GS-HR-406', 'Religious Accommodation Request and Decision', 'Leave & Accommodation', 'Confidential Accommodation File - Separate from General Personnel File', 'Provides a respectful process for requesting and evaluating a workplace change related to a sincerely held religious belief, practice, or observance while limiting inquiry to information reasonably necessary for the request.', 'all_employees', 'restricted', 'GS-HR-406_Religious_Accommodation_Request_and_Decision.docx', array['religious accommodation']::text[], 330),
  ('GS-HR-500', 'Workplace Concern and Complaint Intake', 'Employee Relations & Investigations', 'Restricted Employee Relations / Investigation File', 'Provides employees and managers a clear, neutral intake record for concerns involving harassment, discrimination, retaliation, bullying, wage or timekeeping issues, safety, violence, ethics, supervision, client conduct, policy violations, or other workplace matters.', 'all_employees', 'highly_restricted', 'GS-HR-500_Workplace_Concern_and_Complaint_Intake.docx', array['complaint','harassment','discrimination','retaliation','bullying']::text[], 340),
  ('GS-HR-501', 'Employee or Witness Statement', 'Employee Relations & Investigations', 'Restricted Investigation / Employee Relations / Safety File', 'Captures a person''s first-hand account in their own words for an investigation, safety event, corrective action review, payroll issue, client concern, or other employment matter.', 'all_employees', 'highly_restricted', 'GS-HR-501_Employee_or_Witness_Statement.docx', array['statement','witness']::text[], 350),
  ('GS-HR-502', 'Investigation Interview Record', 'Employee Relations & Investigations', 'Restricted Investigation File', 'Provides a structured, neutral record of an investigation interview, including the allegation presented, open-ended questions, relevant evidence, credibility factors, follow-up, confidentiality limits, and non-retaliation reminder.', 'hr_only', 'highly_restricted', 'GS-HR-502_Investigation_Interview_Record.docx', '{}'::text[], 360),
  ('GS-HR-503', 'Investigation Findings and Closure Summary', 'Employee Relations & Investigations', 'Restricted Investigation File; Limited Final Personnel Record as Directed', 'Documents the issue investigated, scope, evidence, credibility analysis, findings under the selected standard, policy conclusions, corrective or preventive actions, communication, and closure controls.', 'hr_only', 'highly_restricted', 'GS-HR-503_Investigation_Findings_and_Closure_Summary.docx', '{}'::text[], 370),
  ('GS-HR-504', 'Non-Retaliation, Confidentiality, and Evidence Preservation Reminder', 'Employee Relations & Investigations', 'Restricted Investigation / Employee Relations File', 'Provides a consistent written reminder to reporting persons, subjects, witnesses, managers, or other participants about prohibited retaliation, reasonable confidentiality, evidence preservation, and reporting new concerns during a review.', 'supervisors_and_hr', 'highly_restricted', 'GS-HR-504_Non_Retaliation_Confidentiality_and_Evidence_Preservation_Reminder.docx', '{}'::text[], 380),
  ('GS-HR-505', 'Conflict Resolution and Workplace Agreement', 'Employee Relations & Investigations', 'Employee Relations File / Personnel File as Directed by HR', 'Documents a forward-looking, job-related agreement intended to restore effective working relationships, clarify communication, establish boundaries, and define escalation steps after mediation, coaching, or an employee relations review.', 'supervisors_and_hr', 'restricted', 'GS-HR-505_Conflict_Resolution_and_Workplace_Agreement.docx', '{}'::text[], 390),
  ('GS-HR-600', 'Employee Injury or Illness Initial Report', 'Safety, Injury & Incident Administration', 'Confidential Safety / Workers'' Compensation File - Separate from Personnel File', 'Captures prompt facts about a work-related injury, illness, exposure, or near miss; documents immediate care and notifications; and routes the event into workers'' compensation, safety, and official reporting processes without assigning blame.', 'all_employees', 'highly_restricted', 'GS-HR-600_Employee_Injury_or_Illness_Initial_Report.docx', array['injury','illness','workers compensation','near miss']::text[], 400),
  ('GS-HR-601', 'Workplace Violence, Threat, or Protective Incident Report', 'Safety, Injury & Incident Administration', 'Restricted Safety / Workplace Violence / Investigation File', 'Documents threats, assault, stalking, intimidation, weapon concerns, domestic-violence spillover, suspicious targeting, or other workplace violence indicators and supports immediate protection, threat assessment, evidence preservation, required reporting, and follow-up.', 'all_employees', 'highly_restricted', 'GS-HR-601_Workplace_Violence_Threat_or_Protective_Incident_Report.docx', array['threat','violence','stalking','weapon']::text[], 410),
  ('GS-HR-602', 'Reasonable Suspicion Observation Report', 'Safety, Injury & Incident Administration', 'Restricted Safety / Medical / Employee Relations File', 'Documents specific, contemporaneous observations that may support a reasonable-suspicion fitness-for-duty or substance-testing decision under an approved policy, while avoiding diagnosis, rumor, and unsupported conclusions.', 'hr_only', 'highly_restricted', 'GS-HR-602_Reasonable_Suspicion_Observation_Report.docx', '{}'::text[], 420),
  ('GS-HR-603', 'Vehicle and Property Damage Incident Report', 'Safety, Injury & Incident Administration', 'Safety / Insurance / Property File; Restricted as Applicable', 'Documents collisions, vehicle damage, equipment damage, client property damage, theft, loss, or access compromise involving an employee and supports safety, insurance, client, police, and corrective-action review.', 'all_employees', 'restricted', 'GS-HR-603_Vehicle_and_Property_Damage_Incident_Report.docx', array['vehicle accident','property damage','loss','theft']::text[], 430),
  ('GS-HR-604', 'Safety Corrective Action Record', 'Safety, Injury & Incident Administration', 'Safety Management File', 'Documents a hazard, unsafe condition, near miss, inspection finding, or systemic safety gap; assigns interim controls and permanent corrective actions; and verifies effectiveness and closure.', 'supervisors_and_hr', 'standard', 'GS-HR-604_Safety_Corrective_Action_Record.docx', '{}'::text[], 440),
  ('GS-HR-605', 'Workers'' Compensation Case Administration Checklist', 'Safety, Injury & Incident Administration', 'Confidential Workers'' Compensation / Medical File - Separate from Personnel File', 'Coordinates reporting, official claim forms, medical work status, wage information, leave interaction, return-to-work, carrier communication, anti-retaliation controls, and case closure for a work-related injury or illness.', 'hr_only', 'highly_restricted', 'GS-HR-605_Workers_Compensation_Case_Administration_Checklist.docx', '{}'::text[], 450),
  ('GS-HR-700', 'Voluntary Resignation Acknowledgment', 'Separation & Offboarding', 'Personnel File / Separation', 'Confirms an employee''s voluntary resignation, last day, reason category, work and property transition, final-pay and benefit routing, and any request to rescind or modify the resignation.', 'all_employees', 'standard', 'GS-HR-700_Voluntary_Resignation_Acknowledgment.docx', array['resignation','quit','two weeks notice']::text[], 460),
  ('GS-HR-701', 'Job Abandonment and No-Call/No-Show Notice', 'Separation & Offboarding', 'Personnel File / Attendance and Separation', 'Provides a careful final outreach and review process before treating repeated no-call/no-show conduct as job abandonment, including schedule verification, contact attempts, protected-reason screening, and a clear response deadline.', 'hr_only', 'standard', 'GS-HR-701_Job_Abandonment_and_No_Call_No_Show_Notice.docx', '{}'::text[], 470),
  ('GS-HR-702', 'Separation and Termination Review and Notice', 'Separation & Offboarding', 'Personnel File / Restricted Separation Decision', 'Provides the controlled management and HR review for any involuntary or employer-initiated separation and creates the employee-facing notice, final-pay routing, state notice checklist, property return, access control, and communication record.', 'hr_only', 'restricted', 'GS-HR-702_Separation_and_Termination_Review_and_Notice.docx', '{}'::text[], 480),
  ('GS-HR-703', 'Exit Interview', 'Separation & Offboarding', 'Restricted HR Analytics / Employee Relations; Limited Personnel Record', 'Collects voluntary feedback about supervision, scheduling, pay administration, training, safety, client sites, culture, technology, and reasons for leaving while identifying concerns that require separate investigation or correction.', 'all_employees', 'restricted', 'GS-HR-703_Exit_Interview.docx', array['exit interview']::text[], 490),
  ('GS-HR-704', 'Final Pay, Benefits, Records, and Property Return Checklist', 'Separation & Offboarding', 'Personnel File / Payroll / Benefits / Property Records as Applicable', 'Coordinates every offboarding task: final time verification, final pay, expenses, benefits, state notices, unemployment information, records, property, access, client communication, credential status, and retention.', 'hr_only', 'restricted', 'GS-HR-704_Final_Pay_Benefits_Records_and_Property_Return_Checklist.docx', '{}'::text[], 500),
  ('GS-HR-800', 'Shift Call-Off and Absence Report', 'Security Workforce Operations', 'Scheduling / Attendance Record; Confidential Referral as Applicable', 'Creates a consistent record when an employee reports that they will be late, absent, or unable to complete a shift, and coordinates coverage, notice timing, leave referral, timekeeping, and follow-up.', 'all_employees', 'restricted', 'GS-HR-800_Shift_Call_Off_and_Absence_Report.docx', array['call off','late','absent','no show']::text[], 510),
  ('GS-HR-801', 'Overtime Authorization and Coverage Record', 'Security Workforce Operations', 'Scheduling / Payroll / Client Billing Record', 'Documents planned or emergency overtime, the coverage need, alternatives considered, employee acceptance, fatigue and licensing review, client or budget authorization, and timekeeping reconciliation.', 'supervisors_and_hr', 'restricted', 'GS-HR-801_Overtime_Authorization_and_Coverage_Record.docx', array['overtime','coverage']::text[], 520),
  ('GS-HR-802', 'Supervisor Site Visit and Field Training Record', 'Security Workforce Operations', 'Operations / Training / Performance Record', 'Documents required field leadership: site presence, employee check-in, post-order review, training, client observations, safety conditions, equipment, performance coaching, and accountable follow-up.', 'supervisors_and_hr', 'standard', 'GS-HR-802_Supervisor_Site_Visit_and_Field_Training_Record.docx', '{}'::text[], 530),
  ('GS-HR-803', 'License Expiration and Compliance Deficiency Notice', 'Security Workforce Operations', 'Credential / Qualification File and Personnel File as Applicable', 'Provides advance notice and formal documentation when a required license, guard card, endorsement, certification, clearance, training, background recheck, or driving qualification is expiring, missing, suspended, or otherwise deficient.', 'supervisors_and_hr', 'standard', 'GS-HR-803_License_Expiration_and_Compliance_Deficiency_Notice.docx', array['license expiration','guard card','certification']::text[], 540),
  ('GS-HR-804', 'Removal from Schedule and Reinstatement Notice', 'Security Workforce Operations', 'Personnel File / Scheduling Administration; Restricted Case File as Applicable', 'Documents a temporary removal from some or all scheduled work due to licensing, qualification, investigation, safety, client-site, availability, or administrative reasons and defines the exact conditions and approval required for reinstatement.', 'supervisors_and_hr', 'restricted', 'GS-HR-804_Removal_from_Schedule_and_Reinstatement_Notice.docx', array['removed from schedule','reinstatement']::text[], 550),
  ('GS-HR-805', 'Post Transfer and Temporary Assignment Notice', 'Security Workforce Operations', 'Personnel File / Assignment and Scheduling Record', 'Communicates an approved permanent transfer, temporary assignment, relief detail, special event, or client-site reassignment, including schedule, pay review, duties, licensing, post orders, training, property, and end or review date.', 'supervisors_and_hr', 'standard', 'GS-HR-805_Post_Transfer_and_Temporary_Assignment_Notice.docx', '{}'::text[], 560);

create or replace function public.service_get_hr_template_library(
  target_actor_id uuid,
  target_search text default null,
  target_category text default null,
  target_audience text default null,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  effective_permissions text[];
  safe_search text := nullif(btrim(target_search), '');
  safe_category text := nullif(btrim(target_category), '');
  safe_audience text := nullif(btrim(target_audience), '');
  safe_page integer := greatest(coalesce(target_page, 1), 1);
  safe_page_size integer := case when target_page_size in (5,10,20) then target_page_size else 10 end;
  can_see_supervisor boolean := false;
  can_see_hr boolean := false;
  total_count integer := 0;
  total_pages integer := 0;
  category_count integer := 0;
  available_count integer := 0;
  categories_result jsonb := '[]'::jsonb;
  items_result jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from private.hr_template_library_release_gate gate
    where gate.singleton and gate.enabled
  ) then
    raise insufficient_privilege using message = 'The HR document library has not been released.';
  end if;

  effective_permissions := private.document_studio_require_actor(target_actor_id);
  can_see_hr := effective_permissions && array[
    'hr.documents.view','hr.documents.manage','hr.people.view','hr.people.manage'
  ]::text[];
  can_see_supervisor := can_see_hr or effective_permissions && array[
    'schedule.manage','schedule.publish','scheduler.manage','time.manage',
    'requests.manage','licensing.manage','patrol.manage','patrol.operations.view',
    'directory.edit_basic'
  ]::text[];

  if safe_audience is not null and safe_audience not in ('all_employees','supervisors_and_hr','hr_only') then
    raise check_violation using message = 'The document-library audience filter is invalid.';
  end if;

  with visible as (
    select item.*
    from private.hr_template_library_items item
    where item.active
      and (
        item.audience_scope = 'all_employees'
        or (item.audience_scope = 'supervisors_and_hr' and can_see_supervisor)
        or (item.audience_scope = 'hr_only' and can_see_hr)
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', category, 'count', item_count) order by first_order), '[]'::jsonb)
  into categories_result
  from (
    select category, count(*) item_count, min(display_order) first_order
    from visible
    group by category
  ) category_summary;

  with visible as (
    select item.*
    from private.hr_template_library_items item
    where item.active
      and (
        item.audience_scope = 'all_employees'
        or (item.audience_scope = 'supervisors_and_hr' and can_see_supervisor)
        or (item.audience_scope = 'hr_only' and can_see_hr)
      )
  ), filtered as (
    select item.*
    from visible item
    where (safe_category is null or item.category = safe_category)
      and (safe_audience is null or item.audience_scope = safe_audience)
      and (
        safe_search is null
        or item.search_vector @@ websearch_to_tsquery('english'::regconfig, safe_search)
        or lower(item.form_code || ' ' || item.title || ' ' || item.category || ' ' || item.record_class || ' ' || item.purpose || ' ' || array_to_string(item.search_aliases, ' '))
          like '%' || lower(safe_search) || '%'
      )
  )
  select count(*) into total_count from filtered;

  total_pages := case when total_count = 0 then 0 else ceil(total_count::numeric / safe_page_size)::integer end;
  if total_pages > 0 then safe_page := least(safe_page, total_pages); else safe_page := 1; end if;

  with visible as (
    select item.*
    from private.hr_template_library_items item
    where item.active
      and (
        item.audience_scope = 'all_employees'
        or (item.audience_scope = 'supervisors_and_hr' and can_see_supervisor)
        or (item.audience_scope = 'hr_only' and can_see_hr)
      )
  ), filtered as (
    select item.*
    from visible item
    where (safe_category is null or item.category = safe_category)
      and (safe_audience is null or item.audience_scope = safe_audience)
      and (
        safe_search is null
        or item.search_vector @@ websearch_to_tsquery('english'::regconfig, safe_search)
        or lower(item.form_code || ' ' || item.title || ' ' || item.category || ' ' || item.record_class || ' ' || item.purpose || ' ' || array_to_string(item.search_aliases, ' '))
          like '%' || lower(safe_search) || '%'
      )
    order by item.display_order, item.form_code
    offset (safe_page - 1) * safe_page_size
    limit safe_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', item.id,
    'code', item.form_code,
    'title', item.title,
    'category', item.category,
    'recordClass', item.record_class,
    'purpose', item.purpose,
    'audience', item.audience_scope,
    'sensitivity', item.sensitivity,
    'sourceFilename', item.source_filename,
    'sourceDocumentId', item.source_document_id,
    'availability', case
      when item.source_document_id is not null
        and exists(select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled)
        and document.current_version_id is not null
        and private.hr_document_latest_scan_state(document.current_version_id) = 'clean'
      then 'available'
      else 'cataloged'
    end
  ) order by item.display_order, item.form_code), '[]'::jsonb)
  into items_result
  from filtered item
  left join private.hr_documents document on document.id = item.source_document_id and document.archived_at is null;

  select count(distinct item.category) into category_count
  from private.hr_template_library_items item
  where item.active and (
    item.audience_scope = 'all_employees'
    or (item.audience_scope = 'supervisors_and_hr' and can_see_supervisor)
    or (item.audience_scope = 'hr_only' and can_see_hr)
  );

  select count(*) into available_count
  from private.hr_template_library_items item
  join private.hr_documents document on document.id = item.source_document_id and document.archived_at is null
  where item.active
    and exists(select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled)
    and document.current_version_id is not null
    and private.hr_document_latest_scan_state(document.current_version_id) = 'clean'
    and (
      item.audience_scope = 'all_employees'
      or (item.audience_scope = 'supervisors_and_hr' and can_see_supervisor)
      or (item.audience_scope = 'hr_only' and can_see_hr)
    );

  return jsonb_build_object(
    'releaseState', 'released',
    'libraryVersion', (select gate.library_version from private.hr_template_library_release_gate gate where gate.singleton),
    'permissions', jsonb_build_object('canSeeSupervisor', can_see_supervisor, 'canSeeHr', can_see_hr),
    'summary', jsonb_build_object(
      'visibleCount', (select count(*) from private.hr_template_library_items item where item.active and (
        item.audience_scope = 'all_employees'
        or (item.audience_scope = 'supervisors_and_hr' and can_see_supervisor)
        or (item.audience_scope = 'hr_only' and can_see_hr)
      )),
      'matchingCount', total_count,
      'availableCount', available_count,
      'categoryCount', category_count
    ),
    'categories', categories_result,
    'items', items_result,
    'pagination', jsonb_build_object(
      'page', safe_page,
      'pageSize', safe_page_size,
      'totalCount', total_count,
      'totalPages', total_pages
    )
  );
end
$$;

revoke all on function public.service_get_hr_template_library(uuid,text,text,text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.service_get_hr_template_library(uuid,text,text,text,integer,integer)
  to service_role;

do $$
declare baseline record;
begin
  select * into baseline from hr_template_library_preservation_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.document_count <> (select count(*) from private.hr_documents)
    or baseline.document_version_count <> (select count(*) from private.hr_document_versions) then
    raise exception 'HR template library migration changed protected operational records.';
  end if;
  if (select count(*) from private.hr_template_library_items) <> 56 then
    raise exception 'HR template library seed did not reconcile to 56 controlled forms.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
