# State backend of personal-rehearsal. tf.sh adds key = "<env>/<stack>.tfstate".
#
# The rehearsal lives in the personal account, so its state goes to the same
# bucket as personal-stage's (bootstrap/ creates one per account), under its
# own keys. rehearsal.sh down leaves the bucket alone.
#
# PLACEHOLDERS: every REPLACE_ME value below is a placeholder, not a real
# resource. Copy the values of envs/personal-stage/backend.hcl.
# tf.sh refuses to run while a REPLACE_ME remains in this directory.

bucket     = "comparative-tfstate-REPLACE_ME_ACCOUNT_ID-us-east-1"
region     = "us-east-1"
kms_key_id = "REPLACE_ME_STATE_KMS_KEY_ARN"
