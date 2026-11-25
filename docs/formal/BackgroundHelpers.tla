---- MODULE BackgroundHelpers ----
EXTENDS Naturals, FiniteSets

CONSTANTS Helpers, Mutant
VARIABLES parent, jobs, launches, reports, restarted
vars == <<parent, jobs, launches, reports, restarted>>

Init ==
  /\ parent = "running"
  /\ jobs = [h \in Helpers |-> "new"]
  /\ launches = [h \in Helpers |-> 0]
  /\ reports = [h \in Helpers |-> 0]
  /\ restarted = FALSE

Launch(h) ==
  /\ parent = "running"
  /\ jobs[h] = "new"
  /\ jobs' = [jobs EXCEPT ![h] = "working"]
  /\ launches' = [launches EXCEPT ![h] = @ + 1]
  /\ UNCHANGED <<parent, reports, restarted>>

Complete(h, outcome) ==
  /\ jobs[h] = "working"
  /\ jobs' = [jobs EXCEPT ![h] = outcome]
  /\ reports' = IF Mutant = "lost-report" THEN reports ELSE [reports EXCEPT ![h] = @ + 1]
  /\ UNCHANGED <<parent, launches, restarted>>

FinishParent ==
  /\ parent = "running"
  /\ (Mutant = "wait" => \A h \in Helpers : jobs[h] # "working")
  /\ parent' = "finished"
  /\ UNCHANGED <<jobs, launches, reports, restarted>>

StopParent ==
  /\ parent = "running"
  /\ parent' = "stopped"
  /\ jobs' = IF Mutant = "cascade"
             THEN [h \in Helpers |-> IF jobs[h] = "working" THEN "lost" ELSE jobs[h]]
             ELSE jobs
  /\ UNCHANGED <<launches, reports, restarted>>

Restart ==
  /\ ~restarted
  /\ restarted' = TRUE
  /\ UNCHANGED <<parent, jobs, launches, reports>>

ReplayLaunch(h) ==
  /\ restarted /\ launches[h] = 1
  /\ launches' = IF Mutant = "duplicate" THEN [launches EXCEPT ![h] = @ + 1] ELSE launches
  /\ UNCHANGED <<parent, jobs, reports, restarted>>

Outcomes == {"done", "error", "interrupted"}
Next ==
  \/ \E h \in Helpers : Launch(h) \/ ReplayLaunch(h) \/ \E o \in Outcomes : Complete(h, o)
  \/ FinishParent \/ StopParent \/ Restart

Spec == Init /\ [][Next]_vars

ParentCanFinish ==
  parent = "running" /\ (\A h \in Helpers : launches[h] = 1) => ENABLED FinishParent
StopKeepsHelpers == \A h \in Helpers : jobs[h] # "lost"
OneLaunch == \A h \in Helpers : launches[h] \in 0..1
OneReport == \A h \in Helpers : reports[h] = IF jobs[h] \in Outcomes THEN 1 ELSE 0

====
