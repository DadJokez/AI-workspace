terraform {
  required_version = "~> 1.17"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
    # Ephemeral random_password, which first shipped in 3.7.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}
