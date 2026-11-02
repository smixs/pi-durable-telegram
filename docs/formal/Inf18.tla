---------------- MODULE Inf18 ----------------
EXTENDS Naturals, Sequences
CONSTANT Mutant
VARIABLES kind, enabled, overflow, attempt, delays, stage, busy, mode, idleReply
vars == <<kind, enabled, overflow, attempt, delays, stage, busy, mode, idleReply>>
Init == /\ kind \in {"auth", "rate", "other"}
        /\ enabled \in BOOLEAN /\ overflow \in BOOLEAN
        /\ attempt = 1 /\ delays = <<>> /\ stage = "request"
        /\ busy \in BOOLEAN /\ mode = "unset" /\ idleReply = FALSE
Budget == IF kind = "auth" THEN 3 ELSE 5
Delay == IF kind = "auth" THEN 10 * 2^(attempt-1)
         ELSE IF attempt < 5 THEN 5 * 2^(attempt-1) ELSE 60
CanRetry == /\ (enabled \/ Mutant = "disabled")
            /\ (~overflow \/ Mutant = "overflow")
            /\ kind # "other"
            /\ attempt <= Budget + (IF Mutant = "budget" THEN 1 ELSE 0)
Fail == /\ stage = "request"
        /\ IF CanRetry
           THEN /\ stage' = "sleep" /\ delays' = Append(delays, IF Mutant = "delay" THEN 1 ELSE Delay)
           ELSE /\ stage' = "done" /\ UNCHANGED delays
        /\ UNCHANGED <<kind, enabled, overflow, attempt, busy, mode, idleReply>>
Wake == /\ stage = "sleep" /\ stage' = "request" /\ attempt' = attempt+1
        /\ UNCHANGED <<kind, enabled, overflow, delays, busy, mode, idleReply>>
NewInput == /\ mode = "unset" /\ mode' = IF Mutant = "followUp" THEN "followUp" ELSE "steer"
            /\ UNCHANGED <<kind, enabled, overflow, attempt, delays, stage, busy, idleReply>>
DraftStop == /\ ~busy /\ ~idleReply /\ Mutant = "idle_reply" /\ idleReply' = TRUE
             /\ UNCHANGED <<kind, enabled, overflow, attempt, delays, stage, busy, mode>>
Crash == UNCHANGED vars
Next == Fail \/ Wake \/ NewInput \/ DraftStop \/ Crash
Spec == Init /\ [][Next]_vars
SafeRetry == Len(delays) > 0 => enabled /\ ~overflow /\ kind # "other"
Bounded == Len(delays) <= Budget
Backoff == \A i \in 1..Len(delays): delays[i] =
           IF kind = "auth" THEN 10 * 2^(i-1) ELSE IF i < 5 THEN 5 * 2^(i-1) ELSE 60
Steering == mode \in {"unset", "steer"}
IdleSilent == ~busy => ~idleReply
====================================================
