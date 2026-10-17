# ZKnotes Individual Contributor License Agreement

**Version 1.0**

Thank you for your interest in ZKnotes. To keep the project's licensing coherent, contributions can
only be accepted from people who have agreed to the terms below. Signing is a one-time step: it
covers your contributions from then on, and you keep the copyright to your own work.

## Why this exists

ZKnotes is open core. The client and server in this repository are licensed under AGPL-3.0-only, and
the Maintainer runs a hosted service that loads a private administration layer into the same process
as this code. That combination relies on the Maintainer holding rights to all of the core:
obligations under a copyleft license bind licensees, not the copyright holder. A single merged
contribution without this agreement would leave part of the core owned by someone else, and the
arrangement could not be unwound afterwards.

You are not signing your work away. Section 2 is a licence, not an assignment — you keep ownership
and can use your contribution however you like, including in other projects.

## 1. Definitions

**"You"** means the individual who submits a Contribution, or the legal entity authorising it.

**"Maintainer"** means Janko Diminic, who maintains the Project and holds the copyright to it, and
any person or legal entity to which this agreement is transferred under section 8.

**"Contribution"** means any original work of authorship, including any modification of or addition
to an existing work, that You intentionally submit for inclusion in ZKnotes. "Submit" means any form
of communication sent to the Maintainer or the project's repositories — pull requests, patches,
issues containing code — except anything You conspicuously mark in writing as "Not a Contribution".

**"Project"** means the ZKnotes software maintained in this repository, and its derivative works.

## 2. Grant of copyright licence

You grant the Maintainer, and recipients of software distributed by the Maintainer, a perpetual,
worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright licence to reproduce,
prepare derivative works of, publicly display, publicly perform, sublicense and distribute Your
Contribution and such derivative works.

This licence is not limited to AGPL-3.0-only. It permits the Maintainer to distribute Your
Contribution under other licence terms as well, including as part of a proprietary or differently
licensed offering. This is the point of the agreement: without it, the private layer described above
could not be combined with the core.

## 3. Grant of patent licence

You grant the Maintainer, and recipients of software distributed by the Maintainer, a perpetual,
worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section)
patent licence to make, have made, use, offer to sell, sell, import and otherwise transfer Your
Contribution, where such licence applies only to those patent claims licensable by You that are
necessarily infringed by Your Contribution alone or by combination of Your Contribution with the
Project.

If any entity institutes patent litigation against You or any other entity alleging that Your
Contribution, or the Project to which You contributed, constitutes direct or contributory patent
infringement, then any patent licences granted to that entity under this agreement for that
Contribution or Project terminate as of the date such litigation is filed.

## 4. You have the right to grant this

You represent that You are legally entitled to grant the above licences. If Your employer has rights
to intellectual property You create — which is common — You represent that You have received
permission to make the Contribution on behalf of that employer, that Your employer has waived such
rights, or that Your employer has executed a separate corporate agreement with the Maintainer
(contact: support@zknotes.eu).

## 5. Your own work

You represent that each Contribution is Your original creation. If You wish to submit work that is
not Your original creation, You may submit it separately from any Contribution, identifying the
complete details of its source and of any licence or other restriction of which You are personally
aware, and conspicuously marking it as "Submitted on behalf of a third party: [name]".

Do not paste code from another project into a Contribution without saying where it came from. This
matters more here than in most projects: the licence audit in
[`THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md) is what lets the Maintainer state that the
core carries no incompatible code.

## 6. No obligation, and no warranty

You are not expected to provide support for Your Contribution. Except for the representations in
sections 4 and 5, Your Contribution is provided "as is", without warranties or conditions of any
kind, express or implied.

The Maintainer is under no obligation to accept, merge or keep any Contribution.

## 7. Notify the Maintainer of anything that changes

You agree to notify the Maintainer of any facts or circumstances of which You become aware that
would make these representations inaccurate in any respect.

## 8. Transfer

The Maintainer may transfer this agreement and the licences granted under it, in whole or in part,
to a person or legal entity that takes over the Project, including a company the Maintainer founds
or controls. The licences then continue in that successor's favour on the same terms.

## 9. Versions

If the text of this agreement changes, it gets a new version number. Contributions You submitted
under an earlier version stay under the version You signed; a new version applies only to
Contributions You submit after signing it.

---

## How to sign

When you open a pull request, an automated check looks at the person who opened it and everyone who
authored a commit in it. If anyone has not signed this version yet, it comments on the pull request
and the check stays red. To sign, read this agreement and post exactly this sentence, on its own, as
a new comment on the pull request:

```
I have read the ZKnotes CLA version 1.0 and I hereby sign it.
```

Posting it is Your acceptance of this agreement. It covers the Contributions in that pull request
and every Contribution You submit to the Project afterwards — you will only be asked again if the
agreement gets a new version. If the check does not update after you post it, comment `recheck`.

The check records your GitHub account name and numeric id, when you posted the comment, the pull
request and a link to the comment, the version, and a link to and a checksum of the exact text you
signed. That record is kept in the public `cla-signatures` branch of this repository, because it is
what shows that the Project may use your contribution.

Everyone who authored a commit has to sign, so make your commits with an email address that is
linked to your GitHub account, or with your GitHub no-reply address — the check cannot tell who
wrote a commit otherwise. A co-author named in a `Co-authored-by:` line has to sign too, and needs
to be named by their no-reply address. Changes are accepted only as pull requests, where the check
can do its job; code pasted into an issue cannot be used.
