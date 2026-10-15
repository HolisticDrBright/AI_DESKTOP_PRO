# Campaign starter sequences: DRAFT for review (2026-10-15)

Generated from `src/campaigns/starter-content.ts`; a test fails if the two differ. Mark up this file; the source
is then changed to match. **Nothing here has been sent or scheduled.** A practice installs these as drafts, and
each email stays a draft until a named staff member approves it. For Brandon's practice, the weight loss and
diabetes emails also need his attorney's sign-off before approval.

Each email's one button leads to its own program page (`?via=email`). `{{first_name|there}}` is the only value
filled in from the reader. The footer is added to every email: why the reader is receiving it, the practice's
sender name and mailing address, and the unsubscribe link (plus one-click unsubscribe headers). A broadcast's
`[[…]]` slot is written and approved for each send.

## Longevity Program

Status: **draft**. Approval needed from: Brandon.

### Welcome email 1, sent on confirmation

Subject: Welcome: about the Longevity Program

```text
Hello {{first_name|there}},

Thank you for confirming. You will receive two more short emails about the Longevity Program over the next week, and occasional updates after that. You can stop at any time.

The Longevity Program is led by a practitioner and built around what can be measured and reviewed over time. It is not a set of general tips: what comes next is decided by a practitioner who knows your results.

Nothing in these emails is medical advice, and none of it replaces your own doctor.

[Read about the program] -> [[PUBLIC SITE ADDRESS]]/learn/longevity-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the Longevity Program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

### Welcome email 2, sent 3 days after confirmation

Subject: How the Longevity Program is structured

```text
Hello {{first_name|there}},

The program starts with a consultation. At the first visit, the practitioner learns your history and goals and decides, with you, whether the program fits.

If it does, the program runs in phases of practitioner-authored lessons and habits, with check-ins the practitioner releases. Progress is reviewed against what was actually measured, and the plan changes only when the practitioner changes it.

[See how it works] -> [[PUBLIC SITE ADDRESS]]/learn/longevity-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the Longevity Program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

### Welcome email 3, sent 7 days after confirmation

Subject: Starting with a consultation

```text
Hello {{first_name|there}},

The first step is a consultation request. You choose a few times that suit you, and a practitioner reviews the request and replies.

The request page asks no health questions and takes no payment. Whether the program is right for you is decided together at the first visit.

[Request a consultation from the program page] -> [[PUBLIC SITE ADDRESS]]/learn/longevity-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the Longevity Program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

### Broadcast template, sent only when scheduled

Subject: An update about the Longevity Program

```text
Hello {{first_name|there}},

[[UPDATE: one or two short paragraphs written for this send and approved before it is scheduled]]

[Read about the program] -> [[PUBLIC SITE ADDRESS]]/learn/longevity-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the Longevity Program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

## weight loss program

Status: **draft**. Approval needed from: Brandon and attorney.

### Welcome email 1, sent on confirmation

Subject: Welcome: about the weight loss program

```text
Hello {{first_name|there}},

Thank you for confirming. You will receive two more short emails about the weight loss program over the next week, and occasional updates after that. You can stop at any time.

The program is practitioner-led and supervised. It begins with an evaluation by a clinician, who reviews your history and goals.

Whether any prescription is appropriate is the clinician's decision after that evaluation, and it is not guaranteed. These emails are not an offer of any medication, and nothing in them is medical advice.

[Read about the program] -> [[PUBLIC SITE ADDRESS]]/learn/weight-loss-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the weight loss program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

### Welcome email 2, sent 3 days after confirmation

Subject: How the weight loss program works

```text
Hello {{first_name|there}},

After the evaluation, if the program fits, it proceeds in phases with check-ins the practitioner releases.

Progress is reviewed against what was measured. Results differ from person to person, and no amount or pace of change is promised.

[See how it works] -> [[PUBLIC SITE ADDRESS]]/learn/weight-loss-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the weight loss program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

### Welcome email 3, sent 7 days after confirmation

Subject: Starting with a consultation

```text
Hello {{first_name|there}},

The first step is a consultation request. You choose a few times that suit you, and a practitioner reviews the request and replies.

The request page asks no health questions and takes no payment. Any decision about your care is made by a clinician after an evaluation.

[Request a consultation from the program page] -> [[PUBLIC SITE ADDRESS]]/learn/weight-loss-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the weight loss program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

### Broadcast template, sent only when scheduled

Subject: An update about the weight loss program

```text
Hello {{first_name|there}},

[[UPDATE: one or two short paragraphs written for this send and approved before it is scheduled]]

[Read about the program] -> [[PUBLIC SITE ADDRESS]]/learn/weight-loss-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the weight loss program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

## diabetes program

Status: **draft**. Approval needed from: Brandon and attorney.

### Welcome email 1, sent on confirmation

Subject: Welcome: about the diabetes program

```text
Hello {{first_name|there}},

Thank you for confirming. You will receive two more short emails about the diabetes program over the next week, and occasional updates after that. You can stop at any time.

The diabetes program is practitioner-led and runs alongside the care you already receive. Your own doctor remains responsible for your diabetes care; the program adds to that care and never alters it.

Nothing in these emails is medical advice, and nothing in them suggests changing any medication. Please keep following your own doctor's instructions.

[Read about the program] -> [[PUBLIC SITE ADDRESS]]/learn/diabetes-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the diabetes program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

### Welcome email 2, sent 3 days after confirmation

Subject: How the diabetes program works

```text
Hello {{first_name|there}},

It starts with a consultation. At the first visit, the practitioner learns about your situation and the care you already receive, and decides with you whether the program fits.

If it does, the program runs in phases of practitioner-authored lessons and habits, with check-ins the practitioner releases.

[See how it works] -> [[PUBLIC SITE ADDRESS]]/learn/diabetes-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the diabetes program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

### Welcome email 3, sent 7 days after confirmation

Subject: Starting with a consultation

```text
Hello {{first_name|there}},

The first step is a consultation request. You choose a few times that suit you, and a practitioner reviews the request and replies.

The request page asks no health questions and takes no payment. The program does not replace your own doctor.

[Request a consultation from the program page] -> [[PUBLIC SITE ADDRESS]]/learn/diabetes-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the diabetes program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```

### Broadcast template, sent only when scheduled

Subject: An update about the diabetes program

```text
Hello {{first_name|there}},

[[UPDATE: one or two short paragraphs written for this send and approved before it is scheduled]]

[Read about the program] -> [[PUBLIC SITE ADDRESS]]/learn/diabetes-program?via=email

--

You are receiving this because you asked [[SENDER NAME]] for email updates about the diabetes program.

[[SENDER NAME]]

[[MAILING ADDRESS]]

Unsubscribe: [[UNSUBSCRIBE LINK]]
```
